declare module "playwright" {
  export interface Browser {
    newPage(): Promise<Page>;
    close(): Promise<void>;
    on(event: "disconnected", listener: () => void): void;
  }

  export interface Page {
    route(pattern: string, handler: (route: Route) => void): Promise<void>;
    setExtraHTTPHeaders(headers: Record<string, string>): Promise<void>;
    goto(
      url: string,
      options?: { waitUntil?: string; timeout?: number },
    ): Promise<Response | null>;
    waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
    evaluate<T>(pageFunction: () => T): Promise<T>;
    close(): Promise<void>;
  }

  export interface Route {
    request(): {
      resourceType(): string;
    };
    abort(): Promise<void>;
    continue(): Promise<void>;
  }

  export interface Response {
    ok(): boolean;
    status(): number;
  }

  export const chromium: {
    launch(options?: {
      executablePath?: string;
      headless?: boolean;
      args?: string[];
    }): Promise<Browser>;
  };
}
