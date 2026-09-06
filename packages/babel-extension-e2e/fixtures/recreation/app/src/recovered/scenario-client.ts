import * as React from "react";
import {
  QueryClient,
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";

export type ScenarioState = {
  scenario: string;
  project: { projectId: string; projectName: string; category: string; [key: string]: unknown };
  worker: { id: string; [key: string]: unknown };
  route: string;
  page?: { path?: string; search?: string; showTaskLookupModal?: boolean };
  pageProps?: { showTaskLookupModal?: boolean; [key: string]: unknown };
  showTaskLookupModal?: boolean;
  audio?: { transport?: "fetch" | "xhr" | "blob"; [key: string]: unknown };
  action: { actionId: string; annotations: unknown[]; [key: string]: unknown };
  [key: string]: unknown;
};

export class ScenarioApiError extends Error {
  readonly data: { code: string; httpStatus: number; path: string };
  readonly shape: { message: string; data: ScenarioApiError["data"] };

  constructor(message: string, status: number, procedure: string, code = "INTERNAL_SERVER_ERROR") {
    super(message);
    this.name = "TRPCClientError";
    this.data = { code, httpStatus: status, path: procedure };
    this.shape = { message, data: this.data };
  }
}

export function createScenarioQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000 },
    },
  });
}

export async function loadScenario(signal?: AbortSignal): Promise<ScenarioState> {
  const response = await fetch("/__e2e__/state", { signal, credentials: "omit" });
  if (!response.ok) {
    throw new Error(`Local Babel scenario server is unavailable (${response.status}). Start the E2E scenario server and set BABEL_E2E_API_URL before starting Vite.`);
  }
  const state = await response.json() as ScenarioState;
  if (!state.project?.projectId || !state.worker?.id || typeof state.scenario !== "string") {
    throw new Error("Local Babel scenario server returned an invalid bootstrap state.");
  }
  return state;
}

export async function requestProcedure<T = unknown>(
  procedure: string,
  input: unknown,
  method: "GET" | "POST" = "GET",
  signal?: AbortSignal,
): Promise<T> {
  const payload = JSON.stringify({ json: input ?? null });
  const url = `/api/trpc/${procedure}${method === "GET" ? `?input=${encodeURIComponent(payload)}` : ""}`;
  const response = await fetch(url, {
    method,
    signal,
    credentials: "omit",
    ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: payload } : {}),
  });
  const body = await response.json();
  const envelope = Array.isArray(body) ? body[0] : body;
  if (!response.ok || envelope?.error) {
    const error = envelope?.error?.json ?? envelope?.error;
    throw new ScenarioApiError(
      error?.message ?? `Scenario procedure ${procedure} failed (${response.status})`,
      error?.data?.httpStatus ?? response.status,
      procedure,
      error?.data?.code,
    );
  }
  if (!envelope?.result || !Object.prototype.hasOwnProperty.call(envelope.result, "data")) {
    throw new ScenarioApiError(`Invalid tRPC response for ${procedure}`, 502, procedure, "BAD_GATEWAY");
  }
  const data = envelope.result.data;
  return (data && typeof data === "object" && Object.prototype.hasOwnProperty.call(data, "json") ? data.json : data) as T;
}

// Captured editor calls and their query utilities, not canned procedure responses.
const procedures = [
  "annotations.getAnnotationDiffOverlay",
  "annotations.getAnnotationMetricsDiff",
  "annotations.getReviewActionsForRecordingChunk",
  "application.getAudioPresignedUrls",
  "backgroundNoise.getNoiseEventsForRecordings",
  "forms.getFormInputsByStepId",
  "transcriptionFeedbackForm.getFeedbackReceived",
  "transcriptionFeedbackForm.getForm",
  "transcriptionFeedbackForm.getOrCreateDraft",
  "transcriptionFeedbackForm.getRubricFlagNames",
  "transcriptionFeedbackForm.saveDraft",
  "transcriptions.adminRateTtsTranscription",
  "transcriptions.checkActiveClaimForQueue",
  "transcriptions.claimNextReviewActionFromReviewQueue",
  "transcriptions.claimReviewActionByProcessedTranscriptionId",
  "transcriptions.dropWorkerAction",
  "transcriptions.emitReviewActionEvents",
  "transcriptions.getAnnotationsByReviewActionId",
  "transcriptions.getAssessmentAttemptCount",
  "transcriptions.getAssessmentInfo",
  "transcriptions.getChunkConsensus",
  "transcriptions.getForeignTagDictionary",
  "transcriptions.getLatestReviewActionByProcessedTranscriptionId",
  "transcriptions.getOnboardingAttemptStatus",
  "transcriptions.getReviewActionDataById",
  "transcriptions.getReviewActionsForChunk",
  "transcriptions.getStitchedChunkReviewers",
  "transcriptions.getTranscriptionDiff",
  "transcriptions.getTtsOriginalScript",
  "transcriptions.getTtsScriptContext",
  "transcriptions.getTtsTranscriptionWords",
  "transcriptions.getWorkerPermissionsForProject",
  "transcriptions.isDegradedTranscriptionChunk",
  "transcriptions.saveAnnotationsByReviewActionId",
  "transcriptions.skipTranscriptReviewAction",
  "transcriptions.submitAssessment",
  "transcriptions.submitPracticeAttempt",
  "transcriptions.submitTranscriptReviewAction",
  "transcriptions.transitionToAssessment",
  "tts.getTagNamesByType",
  "worker.getProjectById",
  "worker.getProjects",
  "worker.getProjectsWithAvailability",
];

type QueryOptions = Omit<UseQueryOptions<unknown, ScenarioApiError>, "queryKey" | "queryFn">;
type MutationOptions = Omit<UseMutationOptions<unknown, ScenarioApiError, unknown>, "mutationKey" | "mutationFn">;

function queryKey(procedure: string, input?: unknown) {
  return input === undefined ? [procedure] : [procedure, input];
}

function strictNamespace(values: Record<string, unknown>, name: string): Record<string, unknown> {
  return new Proxy(values, {
    get(target, key) {
      if (typeof key !== "string" || key === "then") return Reflect.get(target, key);
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(`Unsupported recovered API member: ${name}.${key}`);
      }
      return target[key];
    },
  });
}

export type ScenarioAudioTransport = {
  transform: (data: unknown, signal?: AbortSignal) => Promise<unknown>;
  dispose: () => void;
};

export function createScenarioAudioTransport(scenario: ScenarioState): ScenarioAudioTransport {
  const mode = scenario.audio?.transport ?? "fetch";
  if (!["fetch", "xhr", "blob"].includes(mode)) throw new Error(`Unsupported audio transport: ${mode}`);
  const sources = new Map<string, Promise<string>>();
  const objectURLs = new Set<string>();
  const controllers = new Set<AbortController>();
  let generation = 0;

  async function load(source: string, signal?: AbortSignal) {
    const url = new URL(source, window.location.href);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(`Audio compatibility transport requires a local WAV URL: ${url.origin}`);
    }
    const epoch = generation;
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const blob = mode === "xhr" ? await new Promise<Blob>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const cancel = () => { xhr.abort(); reject(new DOMException("Audio request aborted", "AbortError")); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        xhr.open("GET", url.href);
        xhr.responseType = "arraybuffer";
        xhr.onload = () => {
          controller.signal.removeEventListener("abort", cancel);
          if (xhr.status < 200 || xhr.status >= 300) reject(new Error(`Audio request failed (${xhr.status})`));
          else resolve(new Blob([xhr.response], { type: xhr.getResponseHeader("Content-Type") ?? "audio/wav" }));
        };
        xhr.onerror = () => { controller.signal.removeEventListener("abort", cancel); reject(new Error(`Audio request failed: ${url.pathname}`)); };
        xhr.onabort = () => { controller.signal.removeEventListener("abort", cancel); reject(new DOMException("Audio request aborted", "AbortError")); };
        if (controller.signal.aborted) cancel();
        else xhr.send();
      }) : await fetch(url.href, { signal: controller.signal, credentials: "omit" }).then((response) => {
        if (!response.ok) throw new Error(`Audio request failed (${response.status})`);
        return response.blob();
      });
      if (epoch !== generation || controller.signal.aborted) throw new DOMException("Audio transport disposed", "AbortError");
      const objectURL = URL.createObjectURL(blob);
      objectURLs.add(objectURL);
      return objectURL;
    } finally {
      signal?.removeEventListener("abort", abort);
      controllers.delete(controller);
    }
  }
  return {
    async transform(data: unknown, signal?: AbortSignal) {
      if (mode === "fetch") return data;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid presigned audio URL map");
      return Object.fromEntries(await Promise.all(Object.entries(data).map(async ([source, destination]) => {
        if (typeof destination !== "string") throw new Error(`Invalid presigned audio URL for ${source}`);
        let pending = sources.get(destination);
        if (!pending) {
          pending = load(destination, signal).catch((error) => { sources.delete(destination); throw error; });
          sources.set(destination, pending);
        }
        return [source, await pending];
      })));
    },
    dispose() {
      generation += 1;
      for (const controller of controllers) controller.abort();
      for (const url of objectURLs) URL.revokeObjectURL(url);
      controllers.clear();
      objectURLs.clear();
      sources.clear();
    },
  };
}

export function createTrpcFacade(queryClient: QueryClient, audio: ScenarioAudioTransport) {
  const queryProcedure = async (procedure: string, input: unknown, signal?: AbortSignal) => {
    const data = await requestProcedure(procedure, input, "GET", signal);
    return procedure === "application.getAudioPresignedUrls" ? audio.transform(data, signal) : data;
  };
  const api: Record<string, unknown> = {};
  const utils: Record<string, unknown> = {};
  for (const procedure of procedures) {
    const [namespace, name] = procedure.split(".");
    const methods = (api[namespace] ??= {}) as Record<string, unknown>;
    const utilityMethods = (utils[namespace] ??= {}) as Record<string, unknown>;
    methods[name] = {
      useQuery(input?: unknown, options?: QueryOptions) {
        return useQuery({
          ...options,
          queryKey: queryKey(procedure, input),
          queryFn: ({ signal }) => queryProcedure(procedure, input, signal),
        }, queryClient);
      },
      useMutation(options?: MutationOptions) {
        return useMutation({
          ...options,
          mutationKey: [procedure],
          mutationFn: (input: unknown) => requestProcedure(procedure, input, "POST"),
        }, queryClient);
      },
    };
    utilityMethods[name] = {
      invalidate: (input?: unknown) => queryClient.invalidateQueries({ queryKey: queryKey(procedure, input) }),
      refetch: (input?: unknown) => queryClient.refetchQueries({ queryKey: queryKey(procedure, input) }),
      cancel: (input?: unknown) => queryClient.cancelQueries({ queryKey: queryKey(procedure, input) }),
      fetch: (input?: unknown) => queryClient.fetchQuery({ queryKey: queryKey(procedure, input), queryFn: ({ signal }) => queryProcedure(procedure, input, signal) }),
      prefetch: (input?: unknown) => queryClient.prefetchQuery({ queryKey: queryKey(procedure, input), queryFn: ({ signal }) => queryProcedure(procedure, input, signal) }),
      getData: (input?: unknown) => queryClient.getQueryData(queryKey(procedure, input)),
      setData: (input: unknown, updater: unknown) => queryClient.setQueryData(queryKey(procedure, input), updater),
    };
  }
  for (const namespace of Object.keys(api)) {
    api[namespace] = strictNamespace(api[namespace] as Record<string, unknown>, namespace);
    utils[namespace] = strictNamespace(utils[namespace] as Record<string, unknown>, namespace);
  }
  const utilities = strictNamespace({ ...utils, invalidate: () => queryClient.invalidateQueries() }, "utils");
  return {
    h: strictNamespace({ ...api, useUtils: () => utilities }, "trpc"),
    TRPCReactProvider: ({ children }: { children: React.ReactNode }) => children,
  };
}

const routeEvent = "babel:route-change";
const subscribeRoute = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  window.addEventListener(routeEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(routeEvent, listener);
  };
};
const locationSnapshot = () => window.location.pathname + window.location.search + window.location.hash;

export function useRecoveredLocation() {
  return React.useSyncExternalStore(subscribeRoute, locationSnapshot, locationSnapshot);
}

export function navigateRecovered(href: string, replace = false) {
  const destination = new URL(href, window.location.href);
  if (destination.origin !== window.location.origin) {
    throw new Error(`Recovered navigation must remain local: ${destination.origin}`);
  }
  window.history[replace ? "replaceState" : "pushState"](null, "", destination.href);
  window.dispatchEvent(new Event(routeEvent));
}

export function createNavigationAdapter(scenario: ScenarioState, queryClient: QueryClient) {
  const router = {
    push: (href: string) => navigateRecovered(href),
    replace: (href: string) => navigateRecovered(href, true),
    refresh: () => { void queryClient.invalidateQueries(); window.dispatchEvent(new Event("babel:route-refresh")); },
    back: () => window.history.back(),
    forward: () => window.history.forward(),
  };
  return {
    useRouter: () => router,
    useSearchParams: () => {
      const location = useRecoveredLocation();
      return React.useMemo(() => new URL(location, window.location.origin).searchParams, [location]);
    },
    useParams: () => { useRecoveredLocation(); return { projectName: scenario.project.projectName }; },
    usePathname: () => new URL(useRecoveredLocation(), window.location.origin).pathname,
    notFound: () => { throw new Error("Recovered route was not found"); },
  };
}
