declare module 'claude-code' {
  interface PluginState {
    'system-promt': { selected: string | null; revision: number }
  }
}
