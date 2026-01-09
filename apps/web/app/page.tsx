"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

const MAX_STEPS = 8;
const MAX_OUTPUTS = 6;

type RunLog = {
  event: string;
  message: string;
};

type PlanAgent = {
  name: string;
  role: string;
};

type PlanStep = {
  id: string;
  title: string;
  description: string;
  agent: string;
};

type RunPlan = {
  interpretedGoal: string;
  steps: PlanStep[];
  agents: PlanAgent[];
  outputs: string[];
  questions: string[];
};

type ArtifactResult = {
  outputPath: string;
  relativePath: string;
  previousContent: string;
  content: string;
};

type StepResult = {
  stepId: string;
  title: string;
  agent: string;
  output: string;
};

type RunResult = {
  artifacts: ArtifactResult[];
  steps: StepResult[];
  sources: string[];
  outputs: string[];
  mainArtifact: string;
  plan: RunPlan;
};

type SearchResult = {
  path: string;
  snippet: string;
};

type PlanResponse = {
  plan: RunPlan;
};

type RunEventPayload = {
  stepId?: string;
  title?: string;
  agent?: string;
  path?: string;
  message?: string;
};

const fetchJson = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
};

const formatDocTitle = (file: string) => {
  const clean = file.replace(/\.md$/i, "");
  return (
    clean
      .split("/")
      .pop()
      ?.replace(/[-_]/g, " ")
      .replace(/\b\w/g, (match) => match.toUpperCase()) ?? file
  );
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
  const [prompt, setPrompt] = useState<string>(
    "Draft a customer brief based on the workspace documents."
  );
  const [planStatus, setPlanStatus] = useState<string>("Idle");
  const [planError, setPlanError] = useState<string>("");
  const [plan, setPlan] = useState<RunPlan | null>(null);
  const [clarifications, setClarifications] = useState<string>("");
  const [logs, setLogs] = useState<RunLog[]>([]);
  const [runStatus, setRunStatus] = useState<string>("Idle");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [refinePrompt, setRefinePrompt] = useState<string>("");
  const [rerunStep, setRerunStep] = useState<string>("");

  const selectedLabel = useMemo(() => selectedFile ?? "No document selected", [selectedFile]);

  const planSteps = plan?.steps ?? [];
  const planOutputs = plan?.outputs ?? [];
  const planAgents = plan?.agents ?? [];

  const stepStatus = useMemo(() => {
    const status = new Map<string, "pending" | "active" | "done">();
    planSteps.forEach((step) => status.set(step.id, "pending"));
    logs.forEach((log) => {
      if (log.event === "step_started" && log.message) {
        const stepId = log.message.split("|")[0];
        if (stepId) {
          status.set(stepId, "active");
        }
      }
      if (log.event === "step_completed" && log.message) {
        const stepId = log.message.split("|")[0];
        if (stepId) {
          status.set(stepId, "done");
        }
      }
    });
    return status;
  }, [logs, planSteps]);

  const artifactsWithDiff = useMemo(() => {
    if (!runResult) {
      return [];
    }
    return runResult.artifacts.map((artifact) => ({
      ...artifact,
      diff: getDiffLines(artifact.previousContent ?? "", artifact.content ?? "")
    }));
  }, [runResult]);

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

  const generatePlan = async () => {
    try {
      setPlanStatus("Planning...");
      setPlanError("");
      const data = await fetchJson<PlanResponse>(`${API_BASE_URL}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      setPlan(data.plan);
      setClarifications("");
      setPlanStatus("Plan ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to plan";
      setPlanStatus("Plan failed");
      setPlanError(message);
    }
  };

  const runPlan = async (options?: { mode?: "refine"; startingStepIndex?: number }) => {
    if (!plan) {
      return;
    }
    if (plan.questions.length > 0 && !clarifications.trim()) {
      setPlanError("Please answer the clarifying questions before running.");
      return;
    }

    const runPrompt =
      options?.mode === "refine" && refinePrompt.trim()
        ? refinePrompt.trim()
        : prompt;

    try {
      setLogs([]);
      setRunResult(null);
      setIsRunning(true);
      setRunStatus("Starting...");
      setPlanError("");

      const { runId } = await fetchJson<{ runId: string }>(`${API_BASE_URL}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: runPrompt,
          plan,
          clarifications: clarifications.trim(),
          startingStepIndex: options?.startingStepIndex ?? 0,
          priorArtifacts:
            options?.mode === "refine"
              ? runResult?.artifacts.map((artifact) => ({
                  path: artifact.relativePath,
                  content: artifact.content
                }))
              : []
        })
      });

      setActiveRunId(runId);
      const eventSource = new EventSource(`${API_BASE_URL}/api/run/${runId}/events`);

      const handleLog = (event: string, message: string) => {
        setLogs((prev) => [...prev, { event, message }]);
      };

      eventSource.addEventListener("started", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        setRunStatus(data.message ?? "Started");
        handleLog("started", data.message ?? "Started");
      });

      eventSource.addEventListener("planning", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        setRunStatus(data.message ?? "Planning");
        handleLog("planning", data.message ?? "Planning");
      });

      eventSource.addEventListener("step_started", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        const logMessage = `${data.stepId ?? ""}|${data.agent ?? ""}|${data.title ?? ""}`;
        setRunStatus(`${data.agent ?? "Agent"} working on ${data.title ?? "step"}`);
        handleLog("step_started", logMessage);
      });

      eventSource.addEventListener("step_completed", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        const logMessage = `${data.stepId ?? ""}|${data.agent ?? ""}|${data.title ?? ""}`;
        handleLog("step_completed", logMessage);
      });

      eventSource.addEventListener("artifact_written", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        const message = data.path ? `Wrote ${data.path}` : "Wrote artifact";
        setRunStatus(message);
        handleLog("artifact_written", message);
      });

      eventSource.addEventListener("done", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunResult & { message: string };
        setRunStatus(data.message ?? "Done");
        handleLog("done", data.message ?? "Done");
        eventSource.close();
        setRunResult(data);
        setIsRunning(false);
        setActiveRunId(null);
        if (data.mainArtifact) {
          setSelectedFile(data.mainArtifact);
          const mainArtifact = data.artifacts.find(
            (artifact) => artifact.relativePath === data.mainArtifact
          );
          if (mainArtifact) {
            setContent(mainArtifact.content);
          }
        }
        loadFiles();
      });

      eventSource.addEventListener("cancelled", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as RunEventPayload;
        setRunStatus(data.message ?? "Cancelled");
        handleLog("cancelled", data.message ?? "Cancelled");
        eventSource.close();
        setIsRunning(false);
        setActiveRunId(null);
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
        handleLog("error", message);
        eventSource.close();
        setIsRunning(false);
        setActiveRunId(null);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run";
      setLogs((prev) => [...prev, { event: "error", message }]);
      setRunStatus("Error");
      setIsRunning(false);
      setActiveRunId(null);
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

  const handleCancelRun = async () => {
    if (!activeRunId) {
      return;
    }
    try {
      await fetchJson(`${API_BASE_URL}/api/run/${activeRunId}/cancel`, { method: "POST" });
      setRunStatus("Cancelling...");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to cancel";
      setLogs((prev) => [...prev, { event: "error", message }]);
    }
  };

  const handlePlanStepChange = (index: number, field: keyof PlanStep, value: string) => {
    setPlan((prev) => {
      if (!prev) {
        return prev;
      }
      const steps = [...prev.steps];
      steps[index] = { ...steps[index], [field]: value };
      return { ...prev, steps };
    });
  };

  const handleAddStep = () => {
    setPlan((prev) => {
      if (!prev || prev.steps.length >= MAX_STEPS) {
        return prev;
      }
      const nextStep: PlanStep = {
        id: `step-${prev.steps.length + 1}`,
        title: "New step",
        description: "Describe what should happen.",
        agent: prev.agents[0]?.name ?? "Writer"
      };
      return { ...prev, steps: [...prev.steps, nextStep] };
    });
  };

  const handleRemoveStep = (index: number) => {
    setPlan((prev) => {
      if (!prev) {
        return prev;
      }
      const steps = prev.steps.filter((_, idx) => idx !== index);
      return { ...prev, steps };
    });
  };

  const handleOutputChange = (index: number, value: string) => {
    setPlan((prev) => {
      if (!prev) {
        return prev;
      }
      const outputs = [...prev.outputs];
      outputs[index] = normalizeDocName(value);
      return { ...prev, outputs };
    });
  };

  const handleAddOutput = () => {
    setPlan((prev) => {
      if (!prev || prev.outputs.length >= MAX_OUTPUTS) {
        return prev;
      }
      return { ...prev, outputs: [...prev.outputs, "New Doc.md"] };
    });
  };

  const handleForkPlan = () => {
    if (!runResult?.plan) {
      return;
    }
    setPlan(runResult.plan);
    setPlanStatus("Plan ready (forked)");
    setPlanError("");
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
              <p className="eyebrow">Run builder</p>
              <h1>Plan before you execute</h1>
              <p className="subtext">
                Draft a plan, review each step, and then run a multi-agent workflow that
                generates bundled artifacts.
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
              <button type="button" onClick={generatePlan} disabled={isRunning}>
                Generate Plan
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runPlan()}
                disabled={!plan || isRunning}
              >
                Run Plan
              </button>
              <button
                type="button"
                className="secondary-button danger"
                onClick={handleCancelRun}
                disabled={!activeRunId || !isRunning}
              >
                Cancel Run
              </button>
            </div>
          </div>
          <div className="status-row">
            <span className="status-pill">{planStatus}</span>
            {planError ? <span className="status-error">{planError}</span> : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Plan preview</h3>
            <span className="panel-meta">Review and edit before running</span>
          </div>
          {plan ? (
            <div className="plan-preview">
              <div className="plan-summary">
                <div>
                  <p className="panel-meta">Interpreted goal</p>
                  <h4>{plan.interpretedGoal}</h4>
                </div>
                <div>
                  <p className="panel-meta">Sub-agents</p>
                  <ul className="pill-list">
                    {planAgents.map((agent) => (
                      <li key={agent.name}>
                        <strong>{agent.name}</strong>
                        <span>{agent.role}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="plan-grid">
                <div>
                  <p className="panel-meta">Steps (editable)</p>
                  <ol className="step-list">
                    {planSteps.map((step, index) => (
                      <li key={step.id} className={`step-item ${stepStatus.get(step.id)}`}>
                        <div className="step-header">
                          <input
                            value={step.title}
                            onChange={(event) =>
                              handlePlanStepChange(index, "title", event.target.value)
                            }
                          />
                          <select
                            value={step.agent}
                            onChange={(event) =>
                              handlePlanStepChange(index, "agent", event.target.value)
                            }
                          >
                            {planAgents.map((agent) => (
                              <option key={agent.name} value={agent.name}>
                                {agent.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => handleRemoveStep(index)}
                          >
                            Remove
                          </button>
                        </div>
                        <textarea
                          value={step.description}
                          onChange={(event) =>
                            handlePlanStepChange(index, "description", event.target.value)
                          }
                        />
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handleAddStep}
                    disabled={planSteps.length >= MAX_STEPS}
                  >
                    Add step
                  </button>
                </div>

                <div>
                  <p className="panel-meta">Planned outputs</p>
                  <ul className="output-list">
                    {planOutputs.map((output, index) => (
                      <li key={`${output}-${index}`}>
                        <input
                          value={output}
                          onChange={(event) => handleOutputChange(index, event.target.value)}
                        />
                      </li>
                    ))}
                  </ul>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handleAddOutput}
                    disabled={planOutputs.length >= MAX_OUTPUTS}
                  >
                    Add output
                  </button>

                  {plan.questions.length > 0 && (
                    <div className="clarifications">
                      <p className="panel-meta">Clarifying questions</p>
                      <ul>
                        {plan.questions.map((question) => (
                          <li key={question}>{question}</li>
                        ))}
                      </ul>
                      <textarea
                        placeholder="Answer the questions so we can continue."
                        value={clarifications}
                        onChange={(event) => setClarifications(event.target.value)}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p>Generate a plan to see the steps and outputs.</p>
          )}
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
              <span className="panel-meta">Live status and step progress</span>
            </div>
            <ul className="timeline">
              <li className="timeline-item active">
                <span className="timeline-dot" />
                <span>{runStatus}</span>
              </li>
              {planSteps.map((step) => (
                <li key={step.id} className={`timeline-item ${stepStatus.get(step.id)}`}>
                  <span className="timeline-dot" />
                  <span>
                    {step.title} <em>{step.agent}</em>
                  </span>
                </li>
              ))}
            </ul>
            {runResult?.sources?.length ? (
              <div className="sources">
                <p className="panel-meta">Sources provided</p>
                <ul>
                  {runResult.sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          <div>
            <div className="panel-header">
              <h3>Artifacts bundle</h3>
              <span className="panel-meta">Saved outputs from this run</span>
            </div>
            {runResult ? (
              <div className="artifact-list">
                {runResult.artifacts.map((artifact) => (
                  <button
                    key={artifact.relativePath}
                    type="button"
                    onClick={() => {
                      setSelectedFile(artifact.relativePath);
                      setContent(artifact.content);
                    }}
                  >
                    <strong>{formatDocTitle(artifact.relativePath)}</strong>
                    <span>{artifact.relativePath}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p>Run the plan to generate artifacts.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>What changed</h3>
            <span className="panel-meta">Diffs for updated documents</span>
          </div>
          {runResult ? (
            <div className="diff-grid">
              {artifactsWithDiff.map((artifact) => (
                <div key={artifact.relativePath} className="diff-card">
                  <h4>{artifact.relativePath}</h4>
                  {artifact.diff.length === 0 ? (
                    <p>No line changes detected.</p>
                  ) : (
                    <ul className="diff">
                      {artifact.diff.map((line, index) => (
                        <li key={`${line.type}-${index}`} className={`diff-${line.type}`}>
                          <span>{line.type === "added" ? "+" : "-"}</span>
                          <code>{line.text}</code>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p>Run the plan to see diffs.</p>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h3>Refine this run</h3>
            <span className="panel-meta">Iterate without starting over</span>
          </div>
          <div className="refinement">
            <label htmlFor="refinement">Refinement prompt</label>
            <div className="refinement-row">
              <input
                id="refinement"
                value={refinePrompt}
                onChange={(event) => setRefinePrompt(event.target.value)}
                placeholder="Ask for changes (e.g., add risks, shorten summary)"
              />
              <button
                type="button"
                className="secondary-button"
                onClick={() => runPlan({ mode: "refine" })}
                disabled={isRunning || !runResult}
              >
                Refine outputs
              </button>
            </div>
          </div>
          <div className="refinement">
            <label htmlFor="rerun-step">Re-run from step</label>
            <div className="refinement-row">
              <select
                id="rerun-step"
                value={rerunStep}
                onChange={(event) => setRerunStep(event.target.value)}
              >
                <option value="">Select a step</option>
                {planSteps.map((step, index) => (
                  <option key={step.id} value={String(index)}>
                    {step.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary-button"
                onClick={() => runPlan({ startingStepIndex: Number(rerunStep || 0) })}
                disabled={isRunning || !plan || rerunStep === ""}
              >
                Re-run step
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={handleForkPlan}
                disabled={!runResult}
              >
                Fork run
              </button>
            </div>
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
