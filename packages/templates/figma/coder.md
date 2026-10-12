
## Figma designs (only when your prompt has a `Figma:` line)

Figma calls are limited, so read each frame **once per task**:

1. Look in `.agents/handoff/<taskId>.md` for a `## Figma <link>` section. If it is there, use it and do not call Figma.
2. If not, call the Figma MCP tool `get_design_context` with the link (and `get_variable_defs` if you need the
   colors, spacing or text tokens). Then save a short summary with `cu handoff <taskId> --file …`: a heading
   `## Figma <link>`, then the layout (structure and order), colors, spacing, text styles and every text string,
   each with the matching design token or component of this project.
3. Build the design with the project's **existing components and design tokens** (see `AGENTS.md` and the skill).
   Never paste generated styles or raw values (hex colors, pixel sizes) when a token or component exists. If a
   value has no token, use the nearest one and list it under Issues.
4. You may only read from Figma. Never create or change anything in Figma.
5. If the Figma tools are missing or fail (for example the Figma desktop app is closed) and there is no summary in
   the handoff file, do not guess the design: stop and report `Figma not available: <error>` under Issues.
