# Actualizar Gentle AI y Gentle Shell en una máquina con el fork

Este es el orden para pasar a una release nueva de Gentle AI (por ejemplo v5.1.0) cuando gentle-pi no viene de npm sino del checkout local del fork `Gagaismo/gentle-shell` (`pi list` muestra una ruta, no `npm:gentle-pi`). El fork carga las costuras de orca (ADR 0006): el toggle, la guardia con `estado` y el consentimiento RDD.

1. **El fork sube a la release.** El fork mergea la release de upstream (para v5.1.0, Gagaismo/gentle-shell#9) y en el checkout del fork corrés `git pull`.
2. **El binario y la sync, sin ningún pi trabajando** (#321). Cerrá o dejá terminar todas las sesiones de pi y después:

   ```powershell
   go install github.com/gentleman-programming/gentle-ai/v5/cmd/gentle-ai@v5.1.0
   gentle-ai sync
   ```

3. **Reinstalá gentle-pi desde la ruta local del fork:**

   ```powershell
   pi install <ruta-del-fork>
   ```

   **No** corras `pi install npm:gentle-pi@<versión>` cuando gentle-pi viene del fork: instala el paquete de npm en su lugar y reemplaza las costuras de orca (el toggle, la guardia con `estado` y el consentimiento RDD).
4. **orca-stack:**

   ```powershell
   npx github:Gagaismo/orca-stack#<versión> global
   orca-stack doctor
   ```

   `global` vuelve a achicar el bloque de gentle-ai que la sync dejó completo; `doctor` tiene que quedar sin avisos del bloque.
5. **Sesiones nuevas.** Abrí sesiones nuevas de Claude Code y de pi: los mods y las extensiones se cargan al arrancar, y las sesiones abiertas siguen con lo viejo.
