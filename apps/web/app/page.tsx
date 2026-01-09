"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type RunLog = {
  event: string;
  message: string;
};

const fetchJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

const HomePage = () => {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("Summarize the workspace documentation.");
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [runStatus, setRunStatus] = useState<string>("Idle");

  const selectedLabel = useMemo(() => selectedFile ?? "No file selected", [selectedFile]);

  const loadFiles = useCallback(() => {
    fetchJson<{ files: string[] }>(`${API_BASE_URL}/api/files`)
      .then((data) => {
        setFiles(data.files);
        if (data.files.length > 0 && !selectedFile) {
          setSelectedFile(data.files[0]);
        }
      })
      .catch((error) => {
        setLogs((prev) => [...prev, { event: "error", message: error.message }]);
      });
  }, [selectedFile]);

  useEffect(() => {
    loadFiles();
  }, [loadFiles]);

  useEffect(() => {
    if (!selectedFile) {
      return;
    }
    fetchJson<{ content: string }>(
      `${API_BASE_URL}/api/file?path=${encodeURIComponent(selectedFile)}`
    )
      .then((data) => setContent(data.content))
      .catch((error) => {
        setLogs((prev) => [...prev, { event: "error", message: error.message }]);
      });
  }, [selectedFile]);

  const runAgent = async () => {
    try {
      setLogs([]);
      setRunStatus("Starting...");
      const { runId } = await fetchJson<{ runId: string }>(`${API_BASE_URL}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });

      const eventSource = new EventSource(`${API_BASE_URL}/api/run/${runId}/events`);
      eventSource.addEventListener("started", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setRunStatus(data.message);
        setLogs((prev) => [...prev, { event: "started", message: data.message }]);
      });

      eventSource.addEventListener("progress", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setRunStatus(data.message);
        setLogs((prev) => [...prev, { event: "progress", message: data.message }]);
      });

      eventSource.addEventListener("done", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { message: string };
        setRunStatus(data.message);
        setLogs((prev) => [...prev, { event: "done", message: data.message }]);
        eventSource.close();
        loadFiles();
        if (selectedFile) {
          fetchJson<{ content: string }>(
            `${API_BASE_URL}/api/file?path=${encodeURIComponent(selectedFile)}`
          ).then((data) => setContent(data.content));
        }
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
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run";
      setLogs((prev) => [...prev, { event: "error", message }]);
      setRunStatus("Error");
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h2>Workspace Docs</h2>
        <ul className="file-list">
          {files.map((file) => (
            <li key={file}>
              <button
                className={`file-button ${file === selectedFile ? "active" : ""}`}
                onClick={() => setSelectedFile(file)}
                type="button"
              >
                {file}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <main className="main-content">
        <section className="panel">
          <div className="toolbar">
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button type="button" onClick={runAgent}>
              Run Agent
            </button>
            <span className="status-pill">{runStatus}</span>
          </div>
        </section>

        <section className="panel">
          <h3>{selectedLabel}</h3>
          <div className="markdown">
            {content ? <ReactMarkdown>{content}</ReactMarkdown> : <p>No content.</p>}
          </div>
        </section>

        <section className="panel">
          <h3>Run Log</h3>
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
