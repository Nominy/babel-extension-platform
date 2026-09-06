import * as React from "react";
import * as ReactDOM from "react-dom";
import * as jsxRuntime from "react/jsx-runtime";
import { cva } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { create as createZustandStore } from "zustand";
import type { QueryClient } from "@tanstack/react-query";
import { createNavigationAdapter, createTrpcFacade, type ScenarioAudioTransport, type ScenarioState } from "./scenario-client";

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
  return {
    "92827": jsxRuntime,
    "10241": jsxRuntime,
    "24289": React,
    "70551": React,
    "91284": ReactDOM,
    "9580": ReactDOM,
    "76881": { W: clsx },
    "85780": { m6: twMerge },
    "86602": { j: cva },
    "66889": { cn: (...inputs: Parameters<typeof clsx>) => twMerge(clsx(...inputs)) },
    "99250": { Ue: createZustandStore },
    "3622": { y: workerStore },
    "79181": { default: NextImageAdapter },
    "16372": navigation,
    "23042": navigation,
    "40734": createTrpcFacade(queryClient, audioTransport),
    // Keep the native analytics context/hook, without importing live SDK providers.
    "57460": {
      get z$() { return loadModule<{ z: unknown }>("1088").z; },
      get ng() { return loadModule<{ n: unknown }>("1088").n; },
    },
  };
}
