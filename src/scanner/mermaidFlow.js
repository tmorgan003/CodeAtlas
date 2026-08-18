// Converts an entry-point trace (nodes/edges from entryPointTrace.js) into
// Mermaid `flowchart TD` syntax for embedding directly in a wiki page as a
// fenced ```mermaid block. Colors reuse the same dark-theme tokens already
// defined in public/styles.css (:root[data-theme="dark"]) rather than
// introducing a second palette — entry=accent, internal=neutral panel,
// external=info — the same role mapping the existing hand-rolled SVG
// process-flow renderer in public/app.js already uses for its step boxes.

const NODE_KIND_CLASS = { entry: 'entryNode', internal: 'internalNode', external: 'externalNode' };

const CLASS_DEFS = [
  'classDef entryNode fill:#122730,stroke:#4595b5,color:#e6e8ec,stroke-width:2px;',
  'classDef internalNode fill:#171a21,stroke:#2a2e37,color:#e6e8ec;',
  'classDef externalNode fill:#0d292d,stroke:#3198aa,color:#e6e8ec;',
];

// Mermaid node labels live inside "..." — strip newlines and escape quotes
// so a summary/label string can never break out of the label syntax, and
// cap length so a long function/path name doesn't blow out the diagram.
function escapeLabel(text) {
  return String(text).replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ').slice(0, 80);
}

function nodeLabel(node) {
  const loc = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '';
  return loc ? `${escapeLabel(node.label)}<br/>${escapeLabel(loc)}` : escapeLabel(node.label);
}

function buildMermaidFlowchart(trace) {
  const lines = ['flowchart TD'];
  for (const node of trace.nodes) {
    lines.push(`  ${node.id}["${nodeLabel(node)}"]:::${NODE_KIND_CLASS[node.kind] || 'internalNode'}`);
  }
  for (const edge of trace.edges) {
    lines.push(`  ${edge.from} --> ${edge.to}`);
  }
  for (const def of CLASS_DEFS) lines.push(`  ${def}`);
  if (trace.truncated) lines.push(`  %% diagram truncated at ${trace.nodes.length} nodes — the real call graph is larger`);
  return lines.join('\n');
}

function buildDiagramCaption(route) {
  return `**${route.method} \`${route.path}\`** starting from \`${route.file}\` (line ${route.line})`;
}

module.exports = { buildMermaidFlowchart, buildDiagramCaption };
