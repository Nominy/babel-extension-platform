import { recoveredEditorModuleId, recoveredModuleSources } from "./generated/moduleSources";

export const RECOVERED_EDITOR_MODULE_ID = recoveredEditorModuleId;
export type RecoveredExports = Record<string, unknown>;
export type RecoveredAdapters = Record<string, unknown>;

interface RuntimeModule {
  id: string;
  exports: unknown;
  loaded: boolean;
}

type RecoveredRequire = ((request: string | number) => unknown) & {
  d: (exports: object, definition: Record<string, () => unknown>) => void;
  n: (moduleValue: unknown) => (() => unknown) & { a?: unknown };
  o: (object: unknown, property: string) => boolean;
  r: (exports: object) => void;
  t: (request: unknown, mode: number) => unknown;
  g: typeof globalThis;
  nc: string | undefined;
  e: (chunkId: string | number) => Promise<never>;
};

type WebpackFactory = (module: RuntimeModule, exports: unknown, require: RecoveredRequire) => void;

function normalizeRequest(request: string | number): string {
  const id = String(request);
  if (!/^\d+$/.test(id)) {
    throw new Error(`Unsupported recovered webpack request ${JSON.stringify(request)}; expected a captured numeric module ID`);
  }
  return id;
}

function defineEsModule(exports: object) {
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  Object.defineProperty(exports, "__esModule", { value: true });
}

/** Executes the captured factories unchanged, with only explicit host boundaries. */
export class RecoveredRuntime {
  private readonly modules = new Map<string, RuntimeModule>();
  private readonly loading: string[] = [];
  private readonly localRequire: RecoveredRequire;

  constructor(private readonly adapters: RecoveredAdapters = {}) {
    this.localRequire = this.createRequire();
  }

  require = (request: string | number): unknown => {
    const id = normalizeRequest(request);
    if (Object.prototype.hasOwnProperty.call(this.adapters, id)) return this.adapters[id];
    const cached = this.modules.get(id);
    if (cached) return cached.exports;
    const source = recoveredModuleSources[id];
    if (!source) {
      throw new Error(`Captured Babel module ${id} is unavailable (import chain: ${[...this.loading, id].join(" -> ")}). Capture its static chunk; historical fallback is forbidden.`);
    }
    const module: RuntimeModule = { id, exports: {}, loaded: false };
    this.modules.set(id, module);
    this.loading.push(id);
    try {
      // The source is a complete webpack factory, not a decompiled CommonJS body.
      const factory = new Function(`return (${source});\n//# sourceURL=recovered-babel://${id}.js`)() as WebpackFactory;
      factory.call(module.exports, module, module.exports, this.localRequire);
      module.loaded = true;
      return module.exports;
    } catch (cause) {
      // A failed factory must not poison the cache with a successful-looking partial export.
      this.modules.delete(id);
      const error = new Error(`Failed to initialize captured Babel module ${id}`);
      Object.defineProperty(error, "cause", { value: cause, configurable: true, writable: true });
      throw error;
    } finally {
      this.loading.pop();
    }
  };

  load<T extends RecoveredExports = RecoveredExports>(id: string | number): T {
    return this.require(id) as T;
  }

  private createRequire(): RecoveredRequire {
    const localRequire = ((request: string | number) => this.require(request)) as RecoveredRequire;
    localRequire.d = (exports, definition) => {
      for (const key of Object.keys(definition)) {
        if (!Object.prototype.hasOwnProperty.call(exports, key)) {
          Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
        }
      }
    };
    localRequire.o = (object, property) => Object.prototype.hasOwnProperty.call(object, property);
    localRequire.r = defineEsModule;
    localRequire.n = moduleValue => {
      const getter = moduleValue && (typeof moduleValue === "object" || typeof moduleValue === "function") && "__esModule" in moduleValue && moduleValue.__esModule
        ? () => Reflect.get(moduleValue, "default")
        : () => moduleValue;
      localRequire.d(getter, { a: getter });
      return getter;
    };
    localRequire.t = (request, mode) => {
      const value = mode & 1 ? localRequire(request as string | number) : request;
      if (mode & 8) return value;
      if (value && (typeof value === "object" || typeof value === "function")) {
        if ((mode & 4) && "__esModule" in value && value.__esModule) return value;
        if ((mode & 16) && "then" in value && typeof value.then === "function") return value;
      }
      const namespace: RecoveredExports = Object.create(null);
      defineEsModule(namespace);
      const getters: Record<string, () => unknown> = { default: () => value };
      if ((mode & 2) && value != null) {
        const boxedValue = Object(value);
        const leafPrototypes: unknown[] = [Object.prototype, Array.prototype, Function.prototype];
        for (let current: object | null = boxedValue; current !== null && !leafPrototypes.includes(current); current = Object.getPrototypeOf(current)) {
          for (const key of Object.getOwnPropertyNames(current)) {
            if (key !== "default") getters[key] = () => Reflect.get(boxedValue, key);
          }
        }
      }
      localRequire.d(namespace, getters);
      return namespace;
    };
    localRequire.g = globalThis;
    localRequire.nc = undefined;
    localRequire.e = async chunkId => {
      throw new Error(`Uncaptured dynamic webpack chunk ${chunkId}; the current offline editor graph has no lazy chunks. Capture the requested static dependency before enabling this route.`);
    };
    return new Proxy(localRequire, {
      get(target, property, receiver) {
        if (!Reflect.has(target, property)) {
          throw new Error(`Unsupported recovered webpack runtime helper ${String(property)}`);
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }
}
