// Generated from shared/perfiles-pi.json by `npm run sync-shared`: edit that file, not this one.
export default [
  { "name": "opus-sonnet", "profile": { "orchestrator": { "model": "claude-bridge/claude-opus-5-5" }, "gentle-ai-worker": { "model": "anthropic/claude-opus-5-5" } }, "problem": null },
  { "name": "gpt", "profile": { "orchestrator": { "model": " openai/gpt-5.2 " } }, "problem": null },
  { "name": "vacio", "profile": { "orchestrator": { "model": "claude-bridge/claude-opus-5-5" }, "gentle-ai-worker": { "model": "" } }, "problem": "usa proveedores no permitidos: gentle-ai-worker ()" },
  { "name": "orquestador-vacio", "profile": { "orchestrator": { "model": "  " } }, "problem": "usa proveedores no permitidos: orchestrator ()" },
  { "name": "samu-balanceado", "profile": { "orchestrator": { "model": "claude-bridge/claude-opus-5-5" }, "gentle-ai-explore": { "model": "commandcode/deepseek/deepseek-v4.1-flash" } }, "problem": "usa proveedores no permitidos: gentle-ai-explore (commandcode/deepseek/deepseek-v4.1-flash)" },
  { "name": "no-orchestrator", "profile": { "gentle-ai-worker": { "model": "claude-bridge/claude-sonnet-5-5" } }, "problem": "no define orchestrator.model" },
  { "name": "a b", "profile": { "orchestrator": { "model": "claude-bridge/claude-opus-5-5" } }, "problem": "nombre no válido" },
  { "name": "Global", "profile": { "orchestrator": { "model": "claude-bridge/claude-opus-5-5" } }, "problem": "\"global\" es ambiguo" },
  { "name": "roto", "profile": "claude-bridge/claude-opus-5-5", "problem": "no es un perfil" }
]
