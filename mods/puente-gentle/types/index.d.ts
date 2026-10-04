export type Intercambio = {
  at: number
  pregunta: string
  planteo: string
  respuesta: string
}

export type TemaVista = { tema: string; items: Intercambio[] }

declare module 'claude-code' {
  interface PluginState {
    'puente-gentle': { temas: TemaVista[]; sel: string }
  }
}
