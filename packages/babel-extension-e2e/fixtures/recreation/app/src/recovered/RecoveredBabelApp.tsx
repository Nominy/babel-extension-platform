import React from "react";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { createRecoveredAdapters } from "./adapters";
import { RecoveredRuntime, RECOVERED_EDITOR_MODULE_ID } from "./runtime";
import adapterMapping from "./generated/adapterMapping.json";
import {
  createScenarioAudioTransport,
  createScenarioQueryClient,
  loadScenario,
  navigateRecovered,
  requestProcedure,
  useRecoveredLocation,
  type ScenarioState,
} from "./scenario-client";

type RecoveredEditorModule = {
  RecoveredPageController: React.ComponentType<Record<string, unknown>>;
  RecoveredEditorWorkbench: React.ComponentType<Record<string, unknown>>;
  RecoveredTranscriptPanel: React.ComponentType<Record<string, unknown>>;
};

type NativeHook = { memoizedState: unknown; next: NativeHook | null };
type NativeFiber = {
  type: unknown;
  memoizedProps: Record<string, unknown>;
  memoizedState: NativeHook | null;
  child: NativeFiber | null;
  sibling: NativeFiber | null;
  return: NativeFiber | null;
  stateNode?: { current?: NativeFiber };
};
type NativeTrack = {
  wavesurfer: {
    getCurrentTime: () => number;
    getDuration: () => number;
    getDecodedData: () => AudioBuffer | null;
    isPlaying: () => boolean;
    getVolume: () => number;
    getPlaybackRate: () => number;
  };
  plugins?: { regions?: { getRegions: () => { id: string; start: number; end: number }[] } };
};

type DecodedAudioMetrics = {
  decodedSampleRate: number | null;
  decodedLength: number | null;
  decodedRms: number | null;
};
const decodedRmsCache = new WeakMap<AudioBuffer, number>();
function decodedMetrics(buffer: AudioBuffer | null): DecodedAudioMetrics {
  if (!buffer) return { decodedSampleRate: null, decodedLength: null, decodedRms: null };
  let rms = decodedRmsCache.get(buffer);
  if (rms === undefined) {
    let squared = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < samples.length; index++) squared += samples[index] * samples[index];
    }
    rms = Math.sqrt(squared / Math.max(1, buffer.length * buffer.numberOfChannels));
    decodedRmsCache.set(buffer, rms);
  }
  return { decodedSampleRate: buffer.sampleRate, decodedLength: buffer.length, decodedRms: rms };
}

function nativeSnapshot(root: HTMLElement | null, editor: RecoveredEditorModule, scenario: ScenarioState) {
  const dom = root as unknown as Record<string, unknown> | null;
  const key = dom && Object.keys(dom).find((name) => name.startsWith("__reactFiber$"));
  let current = key && dom ? dom[key] as NativeFiber : null;
  while (current?.return) current = current.return;
  current = current?.stateNode?.current ?? current;
  const pending = current ? [current] : [];
  let workbench: NativeFiber | null = null;
  let panel: Record<string, unknown> | null = null;
  let diffMode = false;
  while (pending.length) {
    const fiber = pending.pop()!;
    if (fiber.type === editor.RecoveredEditorWorkbench) workbench = fiber;
    if (fiber.type === editor.RecoveredTranscriptPanel) panel = fiber.memoizedProps;
    if (typeof fiber.memoizedProps?.isDiffMode === "boolean" && typeof fiber.memoizedProps?.onToggleDiffMode === "function") {
      diffMode = fiber.memoizedProps.isDiffMode;
    }
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  const tracks: ({ id: string; currentTime: number; duration: number; decoded: boolean; playing: boolean; volume: number; playbackRate: number; regions: { id: string; start: number; end: number }[] } & DecodedAudioMetrics)[] = [];
  let listening: unknown = null;
  // Find the real native track-ref by its public WaveSurfer getter contract, never a fixed hook index.
  for (let hook = workbench?.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    if (!state || typeof state !== "object") continue;
    if ("getSnapshot" in state && typeof state.getSnapshot === "function"
      && "nextGapStart" in state && typeof state.nextGapStart === "function") {
      listening = state.getSnapshot();
    }
    if (!("current" in state)) continue;
    const value = state.current;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [id, item] of Object.entries(value)) {
      const track = item as NativeTrack | null;
      if (!track?.wavesurfer || typeof track.wavesurfer.getCurrentTime !== "function") continue;
      const wave = track.wavesurfer;
      const decoded = wave.getDecodedData();
      tracks.push({
        id,
        currentTime: wave.getCurrentTime(),
        duration: wave.getDuration(),
        decoded: decoded != null,
        ...decodedMetrics(decoded),
        playing: wave.isPlaying(),
        volume: wave.getVolume(),
        playbackRate: wave.getPlaybackRate(),
        regions: (track.plugins?.regions?.getRegions() ?? []).map(({ id, start, end }) => ({ id, start, end })),
      });
    }
  }
  return JSON.parse(JSON.stringify({
    scenario: scenario.scenario,
    route: window.location.pathname + window.location.search,
    ready: !!workbench && !!panel,
    reviewActionId: workbench?.memoizedProps.reviewActionId ?? null,
    readOnly: panel?.readOnly ?? workbench?.memoizedProps.readOnly ?? null,
    annotations: panel?.annotations ?? [],
    linterErrors: panel?.linterErrors ?? [],
    lintWarnings: panel?.lintWarnings ?? [],
    saveState: panel?.saveState ?? null,
    diffMode,
    annotationDiff: panel?.annotationDiff ?? null,
    submitGate: panel?.submitGate ?? null,
    listening,
    audio: { ready: tracks.length > 0 && tracks.every((track) => track.duration > 0 && track.decoded), tracks },
  }));
}

class NativeErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    return this.state.error ? (
      <main className="recovered-error" role="alert">
        <h1>Recovered Babel Runtime Failed</h1>
        <pre>{this.state.error.stack ?? this.state.error.message}</pre>
      </main>
    ) : this.props.children;
  }
}

function ProjectsRoute({ scenario }: { scenario: ScenarioState }) {
  const projects = useQuery({
    queryKey: [["worker", "getProjects"], { type: "query" }],
    queryFn: ({ signal }) => requestProcedure<ScenarioState["project"][]>("worker.getProjects", undefined, "GET", signal),
  });
  return (
    <main aria-label="Local projects" className="p-6">
      <h1 className="text-2xl font-semibold">Projects</h1>
      {projects.isPending && <p role="status">Loading projects…</p>}
      {projects.error && <p role="alert">{projects.error.message}</p>}
      <ul>
        {projects.data?.map((project) => {
          const href = project.projectId === scenario.project.projectId ? scenario.page?.path ?? `/transcription/${encodeURIComponent(project.projectName)}` : `/transcription/${encodeURIComponent(project.projectName)}`;
          return <li key={project.projectId}><a className="underline" href={href} onClick={(event) => {
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            navigateRecovered(href);
          }}>{project.projectName}</a></li>;
        })}
      </ul>
    </main>
  );
}

function ModelComparisonLegend({ scenario }: { scenario: ScenarioState }) {
  const comparison = scenario.modelComparison as {
    title?: string; currentModel?: string; referenceModel?: string;
    currentLevel?: number; referenceLevel?: number;
  } | undefined;
  if (!comparison || typeof comparison.title !== "string"
    || typeof comparison.currentModel !== "string" || typeof comparison.referenceModel !== "string") return null;
  return (
    <header aria-label="Local model comparison" className="border-b bg-slate-50 px-4 py-2 text-xs text-slate-700">
      <strong className="text-sm">{comparison.title}</strong>
      <span className="ml-4">L{comparison.referenceLevel}: {comparison.referenceModel} reference → L{comparison.currentLevel}: {comparison.currentModel} current</span>
      <p className="mt-1">Enable the native Diff View below; Compare L{comparison.referenceLevel} selects {comparison.referenceModel}. Green: added · red: removed · amber: substituted. Model disagreement only, not gold accuracy or F1.</p>
    </header>
  );
}

function NativeScene({ scenario, queryClient }: { scenario: ScenarioState; queryClient: QueryClient }) {
  const [native] = React.useState(() => {
    const audioTransport = createScenarioAudioTransport(scenario);
    const runtime: RecoveredRuntime = new RecoveredRuntime(createRecoveredAdapters({
      scenario,
      queryClient,
      audioTransport,
      loadModule: <T,>(id: string) => runtime.require(id) as T,
    }));
    const editor = runtime.load<RecoveredEditorModule>(RECOVERED_EDITOR_MODULE_ID);
    if (!editor.RecoveredPageController || !editor.RecoveredEditorWorkbench || !editor.RecoveredTranscriptPanel) throw new Error("Captured native editor exports are incomplete");
    return { editor, audioTransport, Toaster: runtime.load<{ Toaster: React.ComponentType }>(adapterMapping.nativeModules.toaster).Toaster };
  });
  const route = useRecoveredLocation();
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);
  const root = React.useRef<HTMLElement>(null);
  React.useEffect(() => {
    const diagnostic = Object.freeze({ snapshot: () => nativeSnapshot(root.current, native.editor, scenario) });
    Object.defineProperty(window, "__BABEL_E2E__", { value: diagnostic, configurable: true });
    window.addEventListener("babel:route-refresh", refresh);
    window.addEventListener("pagehide", native.audioTransport.dispose);
    return () => {
      delete (window as unknown as Record<string, unknown>).__BABEL_E2E__;
      window.removeEventListener("babel:route-refresh", refresh);
      window.removeEventListener("pagehide", native.audioTransport.dispose);
      native.audioTransport.dispose();
    };
  }, [native, scenario]);
  React.useEffect(() => {
    if (route === "/") navigateRecovered(scenario.route, true);
  }, [route, scenario.route]);
  const { RecoveredPageController: PageController } = native.editor;
  const Toaster = native.Toaster;
  const pathname = new URL(route, window.location.origin).pathname;
  return (
    <>
      <div data-recovered-shell style={{ display: "flex", minHeight: "100svh" }}>
        <aside aria-label="Local sidebar" style={{ width: 64, flexShrink: 0 }} />
        <main ref={root} className={`recovered-babel-root flex-1${pathname.startsWith("/transcription/") ? " relative flex min-h-svh flex-col h-svh overflow-hidden" : ""}`} data-recovered-scenario={scenario.scenario} data-recovered-module={RECOVERED_EDITOR_MODULE_ID} data-recovered-ready={route !== "/"}>
          <ModelComparisonLegend scenario={scenario} />
          {pathname === "/projects" ? <ProjectsRoute scenario={scenario} /> : route === "/" ? <p role="status">Opening local scenario…</p> : pathname === scenario.page?.path || pathname.startsWith("/transcription/") ? (
            <PageController key={revision} project={scenario.project} {...scenario.pageProps} showTaskLookupModal={scenario.page?.showTaskLookupModal ?? scenario.showTaskLookupModal ?? scenario.pageProps?.showTaskLookupModal ?? false} />
          ) : <section role="alert"><h1>Local route not found</h1><a href="/projects" onClick={(event) => { event.preventDefault(); navigateRecovered("/projects"); }}>Projects</a></section>}
        </main>
      </div>
      <Toaster />
    </>
  );
}

function ScenarioLoader({ queryClient }: { queryClient: QueryClient }) {
  const scenario = useQuery({ queryKey: ["__e2e__state"], queryFn: ({ signal }) => loadScenario(signal), staleTime: Infinity });
  if (scenario.isPending) return <main role="status">Loading local Babel scenario…</main>;
  if (scenario.error) return <main className="recovered-error" role="alert"><h1>Local scenario setup required</h1><pre>{scenario.error.message}</pre></main>;
  return <NativeErrorBoundary><NativeScene scenario={scenario.data} queryClient={queryClient} /></NativeErrorBoundary>;
}

export function RecoveredBabelApp() {
  const [queryClient] = React.useState(createScenarioQueryClient);
  return <QueryClientProvider client={queryClient}><ScenarioLoader queryClient={queryClient} /></QueryClientProvider>;
}
