
## Figma designs

Antigravity subagents may not have the Figma MCP tools. So when the task has a `figma.com` link, **you** read each
frame once before round 1: call the Figma MCP tool `get_design_context` with the link and save a summary with
`{{kit.cmd}} clickup handoff <taskId> --file …` (heading `## Figma <link>`, then layout, colors, spacing, text styles,
text strings, with the matching design tokens). Give the coder and the reviewer the `Figma: <links>` line; they
use the summary in the handoff file. Only read from Figma; never change anything there.
If you cannot reach Figma (no Figma MCP tools, or they fail), stop as Blocked (`NEEDS_HUMAN`) and say how to fix it
(open the Figma desktop app, Dev Mode → Enable desktop MCP server, then refresh the MCP server in Antigravity).
