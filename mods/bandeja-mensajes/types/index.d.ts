export type Mensaje = { id: string; to: string; text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'bandeja-mensajes': { items: Mensaje[] }
  }
}
