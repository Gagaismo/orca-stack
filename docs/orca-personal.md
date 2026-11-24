# Ajustes personales de Orca

Estos ajustes de Orca son tuyos: viven en cada máquina y en cada persona, no en el repo. orca-stack no los configura, `doctor` no los lee ni los exige, y cambiarlos no rompe nada del stack. Configuralos una vez por máquina.

Los nombres de los menús salen de la referencia de Settings de Orca (<https://www.onorca.dev/docs/settings>) y de la página de worktrees (<https://www.onorca.dev/docs/model/worktrees>); si tu versión los muestra con otro nombre, buscá el mismo ajuste.

## Checklist

- [ ] **Mantener la compu despierta mientras trabajan los agentes.**
  - Dónde: Settings → Agents → Keep computer awake. El mismo control está en la barra de estado como Caffeinate (el ícono de la taza).
  - Valor: `Agent` (despierta solo mientras un agente trabaja).
  - Por qué: no hay un servidor remoto siempre prendido que siga trabajando; si la compu se duerme, los workers se cortan a mitad de un ticket.
- [ ] **Confirmar antes de borrar un worktree.**
  - Dónde: el diálogo de borrar un worktree. Cuando git no puede borrar el checkout, Orca ofrece Force Delete, y su flecha tiene Always force delete.
  - Valor: nunca elegir Always force delete; dejar que Orca pida confirmación cada vez.
  - Por qué: Always force delete se acuerda para todos los borrados siguientes, y un worktree con cambios sin commitear se perdería sin preguntar.
- [ ] **Workspace Cleanup solo para los worktrees de bots y automatizaciones.**
  - Dónde: Settings → Workspace Cleanup para las reglas globales, y en los ajustes de cada proyecto, Workspace cleanup → Cleanup rules.
  - Valor: reglas globales apagadas (vienen apagadas); en los proyectos donde trabajan los tickets, la limpieza apagada; reglas propias solo en los proyectos de bots y automatizaciones.
  - Por qué: `limpiar` conserva los worktrees con cambios sin commitear o con un agente vivo; una regla de limpieza más amplia podría borrarlos en segundos.
- [ ] **Quick Commands del stack en cada proyecto.**
  - Dónde: Settings → Quick Commands, con scope Project, en cada proyecto que usa el stack. Orca los guarda en sus ajustes, no en un archivo del repo, así que `init` no los escribe.
  - Valor: exactamente cuatro: `Estado` → `orca-stack estado`, `Vigilar` → `orca-stack vigilar` (sin Enter al final, para escribir los números de la tanda), `Limpiar` → `orca-stack limpiar` y `Doctor` → `orca-stack doctor`. Ninguno es un comando destructivo ni un merge: `limpiar` omite los worktrees con cambios sin commitear o con un agente trabajando.
  - Por qué: los comandos de todos los días quedan a un toque, desde el escritorio o desde el teléfono.

## Lo que configura el stack

No son ajustes personales: son del stack, viven en el repo o en la tarjeta del worktree, y se cambian con un commit, no en Settings de Orca.

- `orca.yaml` (el script de setup de cada worktree nuevo) y `.worktreeinclude` (los archivos locales que se copian a cada worktree): los commitea el repo y los genera `orca-stack init`.
- La metadata de la tarjeta de cada worktree (el issue vinculado): la pone el stack al crear el worktree de un ticket.
