declare module 'python-bridge' {
  interface PythonBridgeInstance {
    ex(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    python(strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    end?(): Promise<void>;
  }

  interface PythonBridgeFactory {
    (options?: { readonly python?: string }): PythonBridgeInstance;
  }

  const pythonBridge: PythonBridgeFactory;
  export default pythonBridge;
}
