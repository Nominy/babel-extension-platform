import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { create as createZustandStore } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { createNavigationAdapter, createTrpcFacade, type ScenarioAudioTransport, type ScenarioState } from "./scenario-client";
import adapterMapping from "./generated/adapterMapping.json";

type AdapterContext = {
  queryClient: QueryClient;
  scenario: ScenarioState;
  audioTransport: ScenarioAudioTransport;
  loadModule: <T>(id: string) => T;
};

function NextImageAdapter(props: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string | { src: string; width?: number; height?: number };
  priority?: boolean;
  unoptimized?: boolean;
  fill?: boolean;
  quality?: number;
}) {
  const { priority, unoptimized: _unoptimized, fill, quality: _quality, src, style, ...imageProps } = props;
  const image = typeof src === "object" ? src : { src };
  return jsxRuntime.jsx("img", {
    ...image,
    ...imageProps,
    loading: priority ? "eager" : imageProps.loading,
    style: fill ? { position: "absolute", inset: 0, width: "100%", height: "100%", ...style } : style,
  });
}

export function createRecoveredAdapters({ queryClient, scenario, audioTransport, loadModule }: AdapterContext) {
  const workerStore = createZustandStore<{
    worker: ScenarioState["worker"] | undefined;
    shareCode: string | undefined;
    setWorker: (worker: ScenarioState["worker"] | undefined) => void;
    setShareCode: (shareCode: string | undefined) => void;
  }>((set) => ({
    worker: scenario.worker,
    shareCode: undefined,
    setWorker: (worker) => set({ worker }),
    setShareCode: (shareCode) => set({ shareCode }),
  }));
  const navigation = createNavigationAdapter(scenario, queryClient);
  const roles = {
    jsxRuntime,
    react: React,
    reactDom: ReactDOM,
    worker: { y: workerStore },
    nextImage: { default: NextImageAdapter },
    navigation,
    trpc: createTrpcFacade(queryClient, audioTransport),
    // Keep the native analytics context/hook, without importing live SDK providers.
    analytics: {
      get z$() { return loadModule<{ z: unknown }>(adapterMapping.nativeModules.analyticsContext).z; },
      get ng() { return loadModule<{ n: unknown }>(adapterMapping.nativeModules.analyticsContext).n; },
    },
  };
  return Object.fromEntries(Object.entries(adapterMapping.roles).flatMap(([name, role]) =>
    role.ids.map(id => [id, roles[name as keyof typeof roles]])));
}
