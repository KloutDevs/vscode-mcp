# Consolidar nexus-mcp/klout-mcp/vscode-mcp en un único cliente cross-platform

Fecha: 2026-09-06
Estado: propuesto, pendiente de aprobación final del usuario

## Contexto

Nahuel quería una herramienta para delegar tareas entre Claude Code y Cursor, distinguiendo
múltiples ventanas de Cursor y múltiples pestañas de agente por ventana, con cambio de modelo
y sin perder respuestas largas por timeout. Auditando el código existente se encontró que esto
ya estaba resuelto parcialmente por un proyecto propio, pero repartido en tres clientes MCP
que se solapan y una extensión (`cursor-mcp-bridge`, dentro de `vscode-mcp/extension/`) atada a
Windows:

- **`klout-mcp`** — versión más vieja del cliente: puerto fijo, sin soporte multi-ventana/pestaña.
- **`nexus-mcp`** — versión más nueva: multi-ventana (`cursor_list_workspaces`, escaneo de
  puertos 9421–9431), multi-pestaña (`composer_id`), pero sin tools de filesystem.
- **`vscode-mcp/src/index.ts`** — tiene tools de filesystem (`read_file`, `write_file`, etc.)
  **y además** su propio set de tools de control de Cursor, duplicando `nexus-mcp` con nombres
  levemente distintos, puerto único fijo, sin multi-ventana.

La extensión (`extension/src/extension.ts`, `cursor-mcp-bridge` v1.1.4) confirma el mensaje al
usuario simulando `Enter` vía PowerShell (`WScript.Shell.AppActivate` + `SendKeys`), lo cual:
1. Solo funciona en Windows — en esta Mac (Darwin) `powershell.exe` no existe.
2. Trae la ventana de Cursor al frente (confirmado por la documentación de Microsoft: `AppActivate`
   llama a `SetForegroundWindow` + `SetFocus`) — robo de foco real, no evitable con este método en
   ningún sistema operativo (confirmado por research: macOS `osascript`/System Events requiere
   frontmost; Linux `xdotool` tiene una excepción parcial que apps Electron como Cursor
   probablemente ignoren). Cursor no expone un comando de "submit sin tecla" — VS Code sí tiene
   `workbench.action.chat.submit`, pero un reporte del foro de Cursor (jul. 2025) confirma que
   falta en Cursor.
3. `deploy.sh` usa `$USERPROFILE` (variable de Windows) y `nexus-mcp` tiene hardcodeado
   `C:/Users/bigma/Desktop/Nahuel/Trabajo/vscode-mcp/scripts/deploy.sh` en `cursor_deploy_extension`.

Además, la extensión asume un puerto fijo (9421, configurable pero estático) y el cliente
descubre ventanas escaneando un rango hardcodeado (9421–9431), lo cual se rompe con más de 11
ventanas o si el puerto por defecto ya está en uso por otra cosa.

## Alcance de este cambio

1. Un único cliente MCP en `vscode-mcp/src/index.ts` (filesystem + control de Cursor completo,
   con multi-ventana y multi-pestaña heredado de `nexus-mcp`).
2. `nexus-mcp` y `klout-mcp` pasan a estado archivado (no se borran los repos, se documenta que
   quedan reemplazados por `vscode-mcp`).
3. `sendEnterKey` deja de invocar PowerShell — pasa a usar `@nut-tree-fork/nut-js`
   (`keyboard.pressKey(Key.Enter)`), una sola implementación para Windows/Mac/Linux.
4. La extensión deja de bindear un puerto fijo — pide uno libre al SO (`listen(0, ...)`) y lo
   publica en un archivo de registro compartido en disco. El cliente lee ese archivo para
   descubrir ventanas activas, sin escanear rangos.
5. `deploy.sh` deja de asumir `$USERPROFILE` — detecta el SO y usa `$HOME` en Mac/Linux.
6. `cursor_deploy_extension` deja de tener el path de Windows hardcodeado — resuelve la ruta
   relativa al propio proyecto en runtime.

Fuera de alcance: no se elimina el robo de foco (es inherente al método de simulación de tecla
en cualquier SO, confirmado por research), solo se documenta como limitación conocida y se
unifica la implementación. No se agrega soporte real a otros forks de VS Code (Windsurf,
VSCodium) en este cambio — los IDs de comando (`glass.*`, `composer.newAgentChat`, etc.) siguen
atados a Cursor específicamente; eso queda para un cambio futuro si se decide encarar la capa de
abstracción por editor.

## Decisiones de diseño

### 1. Un solo cliente, en `vscode-mcp/src/index.ts`

Se fusionan las tools. El archivo resultante mantiene todas las tools de filesystem existentes
(`read_file`, `write_file`, `edit_file`, `list_directory`, `create_directory`, `delete_path`,
`move_path`, `search_files`, `find_files`, `run_command`, `get_workspace_info`, `get_file_info`)
y reemplaza el bloque de tools de Cursor actual por el set más completo de `nexus-mcp`:

| Tool | Origen | Cambios |
|---|---|---|
| `get_context` | nuevo (opcional) | Se decide NO portar el documento de contexto embebido de `nexus-mcp` (es específico de la máquina de Nahuel, con paths de Windows y otros proyectos no relacionados como HonorBridge) — queda fuera de alcance de este MCP. |
| `cursor_list_workspaces` | nexus-mcp | Reemplaza el escaneo de puertos por lectura del archivo de registro (ver sección 3). |
| `cursor_status` | nexus-mcp (con `port` opcional) | — |
| `cursor_open_chat` | nexus-mcp | — |
| `cursor_send_and_wait` | nexus-mcp | — |
| `cursor_send` | nexus-mcp | Reemplaza a `cursor_send_message` de vscode-mcp (mismo propósito, `cursor_send` soporta `composer_id`). |
| `cursor_read_chat` | nexus-mcp | — |
| `cursor_get_model` | vscode-mcp | Se mantiene, no tiene equivalente en nexus-mcp. |
| `cursor_set_model` | nexus-mcp (con `port` opcional) | — |
| `cursor_open_model_picker` | vscode-mcp | Se mantiene. |
| `cursor_open_file` / `cursor_editor_state` / `cursor_diagnostics` | ambos (idénticos) | Sin cambios de comportamiento. |
| `cursor_run_command` / `cursor_list_commands` | ambos (idénticos) | Sin cambios de comportamiento. |
| `cursor_deploy_extension` | nexus-mcp | Se corrige el path hardcodeado (ver sección 5). |

Variable de entorno de puerto: se unifica a `MCP_BRIDGE_PORT` (la que ya usa `vscode-mcp/src`),
descartando `KLOUT_BRIDGE_PORT` de `nexus-mcp` — pero en la práctica deja de ser relevante para
el descubrimito multi-ventana porque ese pasa a basarse en el archivo de registro, no en un
puerto conocido de antemano.

### 2. Archivado de `nexus-mcp` y `klout-mcp`

Se actualiza el `README.md` de ambos repos (ya clonados en `~/Desktop/Trabajo/KloutDevs/`) con
una nota al inicio: "Este proyecto fue absorbido por `vscode-mcp` el 2026-09-06. Ver
https://github.com/KloutDevs/vscode-mcp." No se borran ni se archivan a nivel GitHub (esa
decisión queda para Nahuel, fuera de alcance de este cambio de código).

### 3. Puerto dinámico + archivo de registro

- La extensión, en `startServer()`, cambia `server.listen(port, "127.0.0.1", ...)` por
  `server.listen(0, "127.0.0.1", ...)` — el SO asigna un puerto libre real, sin colisión posible.
  Se elimina la configuración `cursorMcpBridge.port` (deja de tener sentido fijarlo).
- Al levantar, la extensión escribe una entrada en
  `~/.vscode-mcp-bridge/registry.json` (Mac/Linux: `$HOME`; Windows: `%USERPROFILE%`):
  ```json
  { "9531": { "workspace": "vscode-mcp", "pid": 41213, "startedAt": 1798000000000 } }
  ```
  Sobrescribe con lectura-modificación-escritura (lockfile no necesario: escrituras son
  infrecuentes y atómicas por SO al ser un solo proceso por entrada).
- En `deactivate()`, la extensión borra su propia entrada del registro.
- El cliente, en `cursor_list_workspaces`, lee el registro, descarta entradas cuyo `pid` ya no
  esté vivo (`process.kill(pid, 0)` en un try/catch — limpieza pasiva ante cierres abruptos de
  Cursor que no llamaron a `deactivate`), y devuelve el resto.
- El resto de las tools que hoy reciben `port` como parámetro opcional siguen funcionando igual
  (una vez que el cliente conoce el puerto vía `cursor_list_workspaces` u `cursor_open_chat`, lo
  pasa explícitamente en cada llamada subsiguiente).

### 4. `sendEnterKey` sin PowerShell

```ts
import { keyboard, Key } from "@nut-tree-fork/nut-js";
// ...
async function sendEnterKey(): Promise<void> {
  await keyboard.pressKey(Key.Enter);
  await keyboard.releaseKey(Key.Enter);
}
```
Se elimina el `exec(...)` a PowerShell y la lógica de `windowTitle`/`getWorkspaceName()` asociada
a `AppActivate` (ya no aplica: `nut-js` no necesita el título de ventana, opera sobre el foco
actual del SO). Nota de diseño: como el foco sigue siendo necesario para que el Enter llegue a
Cursor, y no hay forma de evitarlo (ver Contexto), se documenta explícitamente en un comentario
en el código y en el README que esta llamada puede robar foco brevemente.

Requiere: agregar `@nut-tree-fork/nut-js` a `extension/package.json`, y documentar en el README
que la primera ejecución en macOS pedirá permiso de Accesibilidad (System Settings → Privacy &
Security → Accessibility) para el proceso de Cursor/Extension Host.

### 5. `deploy.sh` y paths cross-platform

- `deploy.sh`: reemplazar `$USERPROFILE` por detección de plataforma:
  ```bash
  if [ -n "$USERPROFILE" ]; then EXT_HOME="$USERPROFILE"; else EXT_HOME="$HOME"; fi
  EXTENSIONS_DIR="$EXT_HOME/.cursor/extensions"
  ```
- `cursor_deploy_extension` (en el MCP): reemplazar el path absoluto de Windows hardcodeado por
  resolución relativa al módulo (`fileURLToPath(import.meta.url)` + subir a la raíz del repo),
  para que funcione sin importar dónde esté clonado el proyecto ni en qué SO.

## Testing

- Manual, en esta Mac: `npm run build` en `vscode-mcp/` y en `extension/`, `npm run package`,
  instalar el `.vsix` en una ventana de Cursor real, confirmar que `GET /status` responde en el
  puerto que quedó escrito en `~/.vscode-mcp-bridge/registry.json`.
- Abrir dos ventanas de Cursor (dos proyectos distintos), confirmar que `cursor_list_workspaces`
  devuelve ambas con puertos distintos, sin escaneo.
- `cursor_send_and_wait` end-to-end: enviar un mensaje corto, confirmar que la respuesta llega
  sin timeout arbitrario y que el Enter se registra (aceptando el robo de foco momentáneo como
  comportamiento esperado y documentado).
- No hay Windows disponible en esta sesión para probar la rama de `deploy.sh`/registro en ese
  SO — queda pendiente que Nahuel lo valide en su máquina Windows real.

## Riesgos conocidos

- `@nut-tree-fork/nut-js` requiere compilación nativa (`node-gyp`) — puede fallar si faltan
  herramientas de build en la máquina donde se instala la extensión.
- Los IDs de comando de Cursor (`glass.*`, `composer.newAgentChat`, etc.) siguen sin
  confirmación pública estable — cualquier actualización de Cursor puede romperlos sin aviso.
  Esto ya era así antes del cambio; no se agrava ni se resuelve acá.
- El robo de foco momentáneo se mantiene como limitación aceptada, no un bug a resolver.
