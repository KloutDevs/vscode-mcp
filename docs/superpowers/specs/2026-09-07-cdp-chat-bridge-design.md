# Reemplazar el envío por teclado con Chrome DevTools Protocol (CDP)

Fecha: 2026-09-07
Estado: aprobado (validado en vivo esta sesión, 10 turnos de conversación real)

## Contexto

El cambio anterior (`consolidate-cursor-bridge`, archivado el 2026-09-06) consolidó los clientes
MCP y reemplazó PowerShell por `@nut-tree-fork/nut-js` para simular la tecla Enter. Verificado en
esta sesión: **ese mecanismo no es confiable**. Paste funciona, pero el Enter simulado depende de
que la ventana de Cursor tenga foco real de sistema operativo, y:
- Requiere permisos de Accesibilidad/Automatización que no siempre están disponibles (confirmado:
  el entorno de ejecución de Claude Code no puede activar Cursor de forma fiable vía AppleScript).
- Incluso con foco real, el envío entra en carrera con actividad concurrente de otras pestañas
  (falsos positivos de "confirmado").
- El bloqueo interno `AgentRepositoryService not initialised` aparece de forma intermitente y sin
  causa raíz identificada, rompiendo el flujo antes de llegar al Enter.

Se investigó exhaustivamente (research + pruebas en vivo contra Cursor 3.7.36) y se confirmó:
- No existe ningún comando de Cursor/VS Code para enviar un mensaje sin simular una tecla
  (`composer.sendToAgent`, `startComposerPrompt(2)`, `glass.newAgentWithQuery`,
  `workbench.action.chat.submit` — todos no-op o inexistentes).
- Cursor es Electron/Chromium puro y soporta `--remote-debugging-port` de forma nativa (mismo flag
  que Chrome). El chat/composer se renderiza **directamente en el DOM de la ventana principal**
  (clase `.aislash-editor-input`, editor Lexical) — no en un iframe ni webview separado, ni en una
  ventana Electron aparte.
- `Input.insertText` y `Input.dispatchKeyEvent` de CDP generan eventos **confiables**
  (`isTrusted: true`) a nivel de Chromium, algo que Lexical sí acepta (a diferencia de eventos JS
  sintéticos como `new InputEvent()`, que Lexical ignora).
- Verificado en vivo: una conversación real y sostenida de 10 turnos, con `status: "completed"`
  en cada turno, sin fallos.
- La lectura de conversación funciona de forma más simple leyendo directo
  `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (SQLite, tablas
  `ItemTable`/`cursorDiskKV`, claves `composerData:<id>` y `bubbleId:<composerId>:<bubbleId>`) —
  sin necesidad de `fs.watch` sobre JSONL (que no existe en esta versión de Cursor) ni de pasar
  por la extensión.

## Alcance de este cambio

1. **Nuevo módulo CDP en el cliente** (`src/cdp.ts`): conecta por WebSocket nativo de Node
   (disponible desde Node 22+, sin dependencia nueva) a `http://127.0.0.1:<debugPort>/json/list`,
   encuentra la página cuyo `title` coincide con el workspace buscado, hace `Target.attachToTarget`,
   y expone `sendMessage(pageId, text)`: foco vía click real (`Input.dispatchMouseEvent`) +
   `Input.insertText` + `Input.dispatchKeyEvent` (Enter).
2. **Nuevo módulo de lectura SQLite en el cliente** (`src/composerStore.ts`): usa `node:sqlite`
   (built-in desde Node 22.5+, sin dependencia nueva) para leer `composerData:<id>` y
   `bubbleId:<composerId>:<bubbleId>` directo de `state.vscdb`. Reemplaza toda la lógica de
   `/chat/read` basada en JSONL.
3. **Tools del MCP client actualizadas**: `cursor_send`/`cursor_send_and_wait` dejan de llamar al
   bridge HTTP — hablan CDP directo. `cursor_read_chat` deja de llamar al bridge — lee SQLite
   directo. `cursor_list_workspaces` pasa a listar páginas vía `GET /json/list` del propio CDP en
   vez de leer el archivo de registro de la extensión.
4. **Extensión (`cursor-mcp-bridge`) se reduce**: se elimina `sendEnterKey`, `focusChatInput`,
   toda la lógica de `/chat/send`, `/chat/send_and_wait`, `/chat/confirm`, `/chat/read`, el
   registro de puertos (`registry.ts` y su wiring), y la dependencia `@nut-tree-fork/nut-js`. Se
   conservan `/command`, `/editor/*`, `/diagnostics`, `/model/*` — funcionalidad que sí necesita
   comandos internos de VS Code y no tiene equivalente vía CDP. La extensión vuelve a un puerto
   fijo simple (9421) ya que el descubrimiento multi-ventana ahora lo resuelve CDP nativamente
   (una entrada `page` por ventana en `/json/list`, con el `title` revelando el workspace).
5. **Requisito operativo nuevo, documentado**: Cursor debe arrancar con
   `--remote-debugging-port=9222` (o el puerto que se configure). Esto **no se puede activar en
   caliente** — requiere cerrar y reabrir Cursor con el flag. Se documenta en el README cómo
   configurarlo de forma persistente (ítem de Automator/alias en Mac, acceso directo en Windows).

## Fuera de alcance

- No se agrega soporte multi-editor (VS Code puro, Windsurf) — CDP funciona igual en cualquier
  fork de VS Code que exponga `--remote-debugging-port`, pero la clase `.aislash-editor-input` y
  el formato de `state.vscdb` son específicos de Cursor. Portar a otro editor requeriría
  reidentificar el selector del editor de chat y el schema de persistencia.
- No se resuelve la causa raíz de `AgentRepositoryService not initialised` — queda irrelevante
  para el flujo de envío (CDP no la necesita), pero puede seguir afectando comandos que sí pasan
  por la extensión (`/command` con algunos comandos `glass.*`).
- No se automatiza el lanzamiter de Cursor con el flag de debug — es responsabilidad del usuario
  configurarlo una vez en su sistema.

## Decisiones de diseño

### 1. Descubrimiento de ventanas vía CDP, no vía registro propio

`GET http://127.0.0.1:<debugPort>/json/list` devuelve un array con una entrada `type: "page"` por
cada ventana de Cursor abierta bajo el mismo proceso, con su `title` (incluye el nombre del
workspace) y `id` (target ID para `Target.attachToTarget`). Esto reemplaza
`~/.vscode-mcp-bridge/registry.json` para el propósito de listar ventanas — ya no hace falta que
la extensión publique nada a disco para esto.

`cursor_list_workspaces` pasa a: `fetch('http://127.0.0.1:9222/json/list')`, filtrar por
`type === 'page'`, extraer el nombre de workspace del `title` (formato `"<archivo> — <workspace>"`
o similar, a confirmar contra casos reales), devolver `{ pageId, title }` por ventana.

### 2. Envío de mensajes — `src/cdp.ts`

```ts
async function sendMessage(debugPort: number, pageId: string, text: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${debugPort}/devtools/page/${pageId}`);
  // ... attach vía Target.attachToTarget con flatten:true para obtener sessionId
  // Runtime.enable, Input.enable
  // Runtime.evaluate: focus + getBoundingClientRect de '.aislash-editor-input'
  // Input.dispatchMouseEvent mousePressed/mouseReleased en el centro del rect (click real)
  // Input.insertText con el texto
  // Input.dispatchKeyEvent keyDown + keyUp para Enter (windowsVirtualKeyCode: 13)
}
```

Si `.aislash-editor-input` no se encuentra (ninguna pestaña de chat abierta todavía en esa
ventana), el cliente primero llama al bridge HTTP existente (`POST /command` con
`composer.createNewComposerTab`) para crear una, luego reintenta.

### 3. Lectura de conversación — `src/composerStore.ts`

```ts
import { DatabaseSync } from "node:sqlite";

function readComposerData(composerId: string): ComposerData | null { /* ... */ }
function readBubble(composerId: string, bubbleId: string): { text: string; type: number } | null { /* ... */ }
function waitForReply(composerId: string, sinceCount: number, timeoutMs: number): Promise<string> {
  // polling simple sobre readComposerData().fullConversationHeadersOnly.length y .status === "completed"
  // no hace falta fs.watch — la DB se escribe a disco con latencia baja y el polling cada
  // 1-1.5s ya demostró ser confiable en las pruebas de esta sesión
}
```

Nota de diseño: se prefiere **polling simple** sobre `fs.watch` en el archivo `.vscdb` porque
SQLite no garantiza una escritura atómica visible instantáneamente vía eventos de filesystem
(WAL mode puede escribir a un archivo `-wal` separado); el polling cada 1-1.5s ya se probó
confiable en las 10 rondas de esta sesión y es más simple de razonar.

### 4. Extensión reducida — sin registro de puertos, puerto fijo

Se revierte el puerto dinámico + registro (`registry.ts`) del cambio anterior — ya no resuelve
ningún problema real que CDP no resuelva mejor. La extensión vuelve a bindear el puerto fijo
configurable (9421 por defecto) únicamente para las tools que sí dependen de comandos internos
(`/command`, `/editor/*`, `/diagnostics`, `/model/*`). Se elimina `@nut-tree-fork/nut-js` de
`extension/package.json` — deja de ser necesaria.

### 5. Puerto de debug CDP configurable

Nueva variable de entorno para el cliente: `CURSOR_CDP_PORT` (default `9222`). Se documenta en el
README cómo lanzar Cursor con `--remote-debugging-port=9222` de forma persistente por SO.

## Testing

- Manual, ya ejecutado en esta sesión: conversación real de 10 turnos vía el mecanismo CDP
  propuesto (script ad-hoc en `/tmp`, a formalizar como el módulo `src/cdp.ts` de este cambio).
- Unit tests (`node:test`) para `composerStore.ts`: parsing de `fullConversationHeadersOnly`,
  extracción de texto de bubbles, detección de `status: "completed"` — usando fixtures de
  `state.vscdb` de ejemplo (no la DB real del usuario).
- Manual: confirmar `cursor_list_workspaces` vía CDP contra 2+ ventanas de Cursor reales
  abiertas simultáneamente.
- No hay Windows disponible en esta sesión — validar que `--remote-debugging-port` funciona igual
  en Cursor para Windows queda pendiente para el usuario.

## Riesgos conocidos

- `.aislash-editor-input` y el schema de `state.vscdb` son detalles de implementación internos de
  Cursor, no una API pública — pueden cambiar sin aviso en una actualización de Cursor. Mismo tipo
  de riesgo que ya existía con los comandos `glass.*`, no es nuevo, pero ahora es el mecanismo
  *principal* en vez de un detalle secundario.
- Requiere que el usuario lance Cursor con un flag específico — fricción operativa real, a
  diferencia del enfoque anterior que no requería tocar cómo se abre Cursor.
- `node:sqlite` es una API relativamente nueva de Node (estable desde 22.5, marcada
  "Active Development" en algunas versiones) — confirmar el nivel de estabilidad en la versión de
  Node del usuario antes de depender de ella en producción.
