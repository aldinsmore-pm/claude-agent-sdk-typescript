"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type RunLog = {
  event: string;
  message: string;
};

type RunResult = {
  outputPath: string;
  relativePath: string;
  previousContent: string;
  content: string;
  sources: string[];
};

type SearchResult = {
  path: string;
  snippet: string;
};

const TIMELINE_STEPS = [
  "Started",
  "Reading workspace documents",
  "Drafting brief",
  "Writing document",
  "Done"
];

const fetchJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

const formatDocTitle = (file: string) => {
  const clean = file.replace(/\.md$/i, "");
  return clean
    .split("/")
    .pop()
    ?.replace(/[-_]/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase()) ?? file;
};

const normalizeDocName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`;
};

const getDiffLines = (previous: string, next: string) => {
  const previousLines = previous.split("\n");
  const nextLines = next.split("\n");
  const max = Math.max(previousLines.length, nextLines.length);
  const changes: { type: "added" | "removed"; text: string }[] = [];

  for (let index = 0; index < max; index += 1) {
    const before = previousLines[index];
    const after = nextLines[index];
    if (before === after) {
      continue;
    }
    if (before !== undefined && before !== "") {
      changes.push({ type: "removed", text: before });
    }
    if (after !== undefined && after !== "") {
      changes.push({ type: "added", text: after });
    }
  }

  return changes;
};

const HomePage = () => {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("Summarize these notes into a brief.");
  const [refinement, setRefinement] = useState<string>("");
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [runStatus, setRunStatus] = useState<string>("Idle");
  const [timelineIndex, setTimelineIndex] = useState<number>(-1);
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);

  const selectedLabel = useMemo(() => selectedFile ?? "No document selected", [selectedFile]);

  const timeline = useMemo(
    () =>
      TIMELINE_STEPS.map((step, index) => ({
        step,
        status: index < timelineIndex ? "done" : index === timelineIndex ? "active" : "pending"
      })),
    [timelineIndex]
  );

  const diffLines = useMemo(() => {
    if (!lastRun) {
      return [];
    }
    return getDiffLines(lastRun.previousContent ?? "", lastRun.content ?? "");
  }, [lastRun]);

  const updateTimeline = useCallback((message: string) => {
    const normalized = message.toLowerCase();
    const nextIndex = TIMELINE_STEPS.findIndex((step) =>
      normalized.includes(step.toLowerCase())
    );
    if (nextIndex >= 0) {
      setTimelineIndex(nextIndex);
    }
  }, []);

  const loadFiles = useCallback(() => {
    fetchJson<{ files: string[] }>(`${API_BASE_URL}/api/files`)
      .then((data) => {
        setFiles(data.files);
        if (data.files.length > 0 && (!selectedFile || !data.files.includes(selectedFile))) {
          setSelectedFile(data.files[0]);
        }
      })
      .catch((error) => {
        setLogs((prev) => [...prev, { event: "error", message: error.message }]);
      });
  }, [selectedFile]);

  const loadFileContent = useCallback((filePath: string) => {
    fetchJson<{ content: string }>(`${API_BASE_URL}/api/file?path=${encodeURIComponent(filePath)}`)
      .then((data) => setContent(data.content))
      .catch((error) => {
        setLogs((prev) => [...prev, { event: "error", message: error.message }]);
      });
  }, []);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }
    loadFileContent(selectedFile);
  }, [selectedFile, loadFileContent]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults([]);
      return undefined;
    }
    const handle = setTimeout(() => {
      fetchJson<{ results: SearchResult[] }>(
        `${API_BASE_URL}/api/search?query=${encodeURIComponent(searchQuery)}`
      )
        .then((data) => setSearchResults(data.results))
        .catch((error) => {
          setLogs((prev) => [...prev, { event: "error", message: error.message }]);
        });
    }, 250);
    return () => clearTimeout(handle);
  }, [searchQuery]);

  const runAgent = async (mode: "run" | "improve") => {
    try {
      setLogs([]);
      setTimelineIndex(-1);
      setLastRun(null);
      setIsRunning(true);
      setRunStatus("Starting...");
      const fullPrompt =
        mode === "improve" && refinement.trim()
          ? `${prompt}\n\nImprove the brief using this feedback: ${refinement.trim()}`
          : prompt;
      const { runId } = await fetchJson<{ runId: string }>(`${API_BASE_URL}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt })
      });

      const eventSource = new EventSource(`${API_BASE_URL}/api/run/${runId}/events`);
      eventSource.addEventListener("started", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setRunStatus(data.message);
        updateTimeline(data.message);
        setLogs((prev) => [...prev, { event: "started", message: data.message }]);
      });

      eventSource.addEventListener("progress", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setRunStatus(data.message);
        updateTimeline(data.message);
        setLogs((prev) => [...prev, { event: "progress", message: data.message }]);
      });

      eventSource.addEventListener("done", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunResult & { message: string };
        setRunStatus(data.message);
        updateTimeline(data.message);
        setLogs((prev) => [...prev, { event: "done", message: data.message }]);
        eventSource.close();
        setLastRun(data);
        if (data.relativePath) {
          setSelectedFile(data.relativePath);
          setContent(data.content);
        }
        loadFiles();
        setIsRunning(false);
      });

      eventSource.addEventListener("error", (event) => {
        let message = "SSE connection error.";
        if (event instanceof MessageEvent && event.data) {
          try {
            const data = JSON.parse(event.data) as { message?: string };
            if (data.message) {
              message = data.message;
            }
          } catch {
            message = event.data;
          }
        }
        setRunStatus("Error");
        setLogs((prev) => [...prev, { event: "error", message }]);
        eventSource.close();
        setIsRunning(false);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run";
      setLogs((prev) => [...prev, { event: "error", message }]);
      setRunStatus("Error");
      setIsRunning(false);
    }
  };

  const handleCreateDoc = async () => {
    const name = window.prompt("Name your new document (e.g., client-brief.md)");
    const normalized = name ? normalizeDocName(name) : "";
    if (!normalized) {
      return;
    }
    try {
      await fetchJson(`${API_BASE_URL}/api/file`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: normalized, content: `# ${formatDocTitle(normalized)}\n` })
      });
      loadFiles();
      setSelectedFile(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create document";
      setLogs((prev) => [...prev, { event: "error", message }]);
    }
  };

  const handleRenameDoc = async () => {
    if (!selectedFile) {
      return;
    }
    const name = window.prompt("Rename document", selectedFile);
    const normalized = name ? normalizeDocName(name) : "";
    if (!normalized || normalized === selectedFile) {
      return;
    }
    try {
      await fetchJson(`${API_BASE_URL}/api/file`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedFile, newPath: normalized })
      });
      loadFiles();
      setSelectedFile(normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to rename document";
      setLogs((prev) => [...prev, { event: "error", message }]);
    }
  };

  const handleDeleteDoc = async () => {
    if (!selectedFile) {
      return;
    }
    const confirmed = window.confirm(`Delete ${selectedFile}? This cannot be undone.`);
    if (!confirmed) {
      return;
    }
    try {
      await fetchJson(`${API_BASE_URL}/api/file?path=${encodeURIComponent(selectedFile)}`, {
        method: "DELETE"
      });
      setSelectedFile(null);
      setContent("");
      loadFiles();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to delete document";
      setLogs((prev) => [...prev, { event: "error", message }]);
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div>
            <p className="sidebar-label">Workspace</p>
            <h2>Notebook</h2>
          </div>
          <button type="button" className="secondary-button" onClick={handleCreateDoc}>
            New Doc
          </button>
        </div>

        <div className="search-box">
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search documents"
          />
        </div>

        {searchQuery && searchResults.length > 0 && (
          <div className="search-results">
            <p className="sidebar-label">Search results</p>
            <ul>
              {searchResults.map((result) => (
                <li key={result.path}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(result.path);
                      setSearchQuery("");
                    }}
                  >
                    <strong>{formatDocTitle(result.path)}</strong>
                    <span>{result.snippet}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="sidebar-label">Documents</p>
        <ul className="file-list">
          {files.map((file) => (
            <li key={file}>
              <button
                className={`file-button ${file === selectedFile ? "active" : ""}`}
                onClick={() => setSelectedFile(file)}
                type="button"
              >
                <span>{formatDocTitle(file)}</span>
                <small>{file}</small>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main-content">
        <section className="panel hero-panel">
          <div className="hero-header">
            <div>
              <p className="eyebrow">Ask / Generate</p>
              <h1>Create a brief from your workspace</h1>
              <p className="subtext">
                Drop notes in the notebook, ask for a work product, and we will save it as a
                document.
              </p>
            </div>
            <div className="doc-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={handleRenameDoc}
                disabled={!selectedFile}
              >
                Rename
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={handleDeleteDoc}
                disabled={!selectedFile}
              >
                Delete
              </button>
            </div>
          </div>

          <div className="toolbar">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <div className="toolbar-actions">
              <button type="button" onClick={() => runAgent("run")} disabled={isRunning}>
                Generate Brief
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runAgent("run")}
                disabled={isRunning}
              >
                Re-run
              </button>
            </div>
          </div>
          <div className="refinement">
            <label htmlFor="refinement">Improve output</label>
            <div className="refinement-row">
              <input
                id="refinement"
                value={refinement}
                onChange={(event) => setRefinement(event.target.value)}
                placeholder="Optional feedback (e.g., make it shorter, add risks)"
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => runAgent("improve")}
                disabled={isRunning}
              >
                Improve
              </button>
            </div>
          </div>
          <div className="status-row">
            <span className="status-pill">{runStatus}</span>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>{selectedLabel}</h3>
            <span className="panel-meta">Rendered document</span>
          </div>
          <div className="markdown">
            {content ? <ReactMarkdown>{content}</ReactMarkdown> : <p>No content.</p>}
          </div>
        </section>

        <section className="panel grid-panel">
          <div>
            <div className="panel-header">
              <h3>Run timeline</h3>
              <span className="panel-meta">What the agent is doing</span>
            </div>
            <ol className="timeline">
              {timeline.map((item) => (
                <li key={item.step} className={`timeline-item ${item.status}`}>
                  <span className="timeline-dot" />
                  <span>{item.step}</span>
                </li>
              ))}
            </ol>
            {lastRun?.sources?.length ? (
              <div className="sources">
                <p className="panel-meta">Sources provided</p>
                <ul>
                  {lastRun.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div>
            <div className="panel-header">
              <h3>What changed</h3>
              <span className="panel-meta">Diff from last output</span>
            </div>
            {lastRun ? (
              <div className="diff">
                {diffLines.length === 0 ? (
                  <p>No line changes detected.</p>
                ) : (
                  <ul>
                    {diffLines.map((line, index) => (
                      <li key={`${line.type}-${index}`} className={`diff-${line.type}`}>
                        <span>{line.type === "added" ? "+" : "-"}</span>
                        <code>{line.text}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <p>Run the agent to see changes.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Run log</h3>
            <span className="panel-meta">Detailed events</span>
          </div>
          <ul className="log-list">
            {logs.length === 0 ? (
              <li>Waiting for events...</li>
            ) : (
              logs.map((log, index) => (
                <li key={`${log.event}-${index}`}>
                  <strong>{log.event}</strong>: {log.message}
                </li>
              ))
            )}
          </ul>
        </section>
      </main>
    </div>
  );
};

export default HomePage;
