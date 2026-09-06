import React from "react";
import { QueryClientProvider, useQuery, type QueryClient } from "@tanstack/react-query";
import { createRecoveredAdapters } from "./adapters";
import { RecoveredRuntime, RECOVERED_EDITOR_MODULE_ID } from "./runtime";
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

function nativeSnapshot(root: HTMLElement | null, editor: RecoveredEditorModule, scenario: ScenarioState) {
  const dom = root as unknown as Record<string, unknown> | null;
  const key = dom && Object.keys(dom).find((name) => name.startsWith("__reactFiber$"));
  let current = key && dom ? dom[key] as NativeFiber : null;
  while (current?.return) current = current.return;
  current = current?.stateNode?.current ?? current;
  const pending = current ? [current] : [];
  let workbench: NativeFiber | null = null;
  let table: Record<string, unknown> | null = null;
  while (pending.length) {
    const fiber = pending.pop()!;
    if (fiber.type === editor.RecoveredEditorWorkbench) workbench = fiber;
    if (Array.isArray(fiber.memoizedProps?.annotations) && fiber.memoizedProps?.saveState) table = fiber.memoizedProps;
    if (fiber.child) pending.push(fiber.child);
    if (fiber.sibling) pending.push(fiber.sibling);
  }
  const tracks: { id: string; currentTime: number; duration: number; decoded: boolean; playing: boolean; volume: number; playbackRate: number; regions: { id: string; start: number; end: number }[] }[] = [];
  // Find the real native track-ref by its public WaveSurfer getter contract, never a fixed hook index.
  for (let hook = workbench?.memoizedState; hook; hook = hook.next) {
    const state = hook.memoizedState;
    if (!state || typeof state !== "object" || !("current" in state)) continue;
    const value = state.current;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [id, item] of Object.entries(value)) {
      const track = item as NativeTrack | null;
      if (!track?.wavesurfer || typeof track.wavesurfer.getCurrentTime !== "function") continue;
      const wave = track.wavesurfer;
      tracks.push({
        id,
        currentTime: wave.getCurrentTime(),
        duration: wave.getDuration(),
        decoded: wave.getDecodedData() != null,
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
    ready: !!workbench && !!table,
    reviewActionId: workbench?.memoizedProps.reviewActionId ?? null,
    readOnly: table?.readOnly ?? workbench?.memoizedProps.readOnly ?? null,
    annotations: table?.annotations ?? [],
    linterErrors: table?.linterErrors ?? [],
    lintWarnings: table?.lintWarnings ?? [],
    saveState: table?.saveState ?? null,
    diffMode: table?.diffMode ?? false,
    annotationDiff: table?.annotationDiff ?? null,
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
    queryKey: ["worker.getProjects"],
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
    if (!editor.RecoveredPageController || !editor.RecoveredEditorWorkbench) throw new Error("Captured native editor exports are incomplete");
    return { editor, audioTransport, Toaster: runtime.load<{ Toaster: React.ComponentType }>("61704").Toaster };
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
      <main ref={root} className="recovered-babel-root" data-recovered-scenario={scenario.scenario} data-recovered-module={RECOVERED_EDITOR_MODULE_ID} data-recovered-ready={route !== "/"}>
        {pathname === "/projects" ? <ProjectsRoute scenario={scenario} /> : route === "/" ? <p role="status">Opening local scenario…</p> : pathname === scenario.page?.path || pathname.startsWith("/transcription/") ? (
          <PageController key={revision} project={scenario.project} {...scenario.pageProps} showTaskLookupModal={scenario.page?.showTaskLookupModal ?? scenario.showTaskLookupModal ?? scenario.pageProps?.showTaskLookupModal ?? false} />
        ) : <section role="alert"><h1>Local route not found</h1><a href="/projects" onClick={(event) => { event.preventDefault(); navigateRecovered("/projects"); }}>Projects</a></section>}
      </main>
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
