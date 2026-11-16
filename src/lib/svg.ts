import type { PaperConfig, PlotLayerOutput, SVGExportOptions } from "./types.ts";

/**
 * Generates a physical-unit (`mm`) SVG document with Inkscape / AxiDraw layer groups.
 */
export function serializePlotToSVG(
  paper: PaperConfig,
  layers: PlotLayerOutput[],
  options: SVGExportOptions = {}
): string {
  const precision = options.precision ?? 2;
  const fmt = (n: number) => n.toFixed(precision);
  const w = paper.widthMm;
  const h = paper.heightMm;

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8" standalone="no"?>`);
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`
  );

  if (options.backgroundColor) {
    lines.push(
      `  <rect x="0" y="0" width="${w}" height="${h}" fill="${options.backgroundColor}" stroke="none" data-plotter-ignore="true" />`
    );
  }

  if (options.includePaperBorder) {
    const m = options.marginMm ?? 10;
    lines.push(
      `  <rect x="${fmt(m)}" y="${fmt(m)}" width="${fmt(w - 2 * m)}" height="${fmt(h - 2 * m)}" fill="none" stroke="#d4d4d0" stroke-width="0.15" stroke-dasharray="1.5 1.5" data-plotter-ignore="true" />`
    );
  }

  const hiddenSet =
    options.hiddenLayerIds instanceof Set
      ? options.hiddenLayerIds
      : new Set(options.hiddenLayerIds ?? []);

  // Optional debug pen-up travel visualization layer
  if (options.includePenTravel) {
    const travelWidth = options.penTravelStrokeWidthMm ?? 0.38;
    const travelColor = options.penTravelColor ?? "#ef4444";
    const travelOpacity = options.penTravelOpacity ?? 0.85;
    lines.push(
      `  <g id="layer-pen-travel" inkscape:groupmode="layer" inkscape:label="00-Debug-Pen-Travel" fill="none" stroke="${escapeXml(travelColor)}" stroke-width="${fmt(travelWidth)}" stroke-opacity="${travelOpacity}" stroke-dasharray="1.6 1.4" stroke-linecap="round" data-plotter-ignore="true">`
    );
    for (const layer of layers) {
      if (layer.polylines.length === 0 || hiddenSet.has(layer.id)) continue;
      let prevX = 0;
      let prevY = 0;
      const travelParts: string[] = [];
      for (const poly of layer.polylines) {
        const start = poly[0];
        if (Math.hypot(start[0] - prevX, start[1] - prevY) > 0.25) {
          travelParts.push(`M${fmt(prevX)},${fmt(prevY)}L${fmt(start[0])},${fmt(start[1])}`);
        }
        const end = poly[poly.length - 1];
        prevX = end[0];
        prevY = end[1];
      }
      if (travelParts.length > 0) {
        lines.push(`    <path d="${travelParts.join(" ")}" />`);
      }
    }
    lines.push(`  </g>`);
  }

  const combinePaths = options.combinePathsPerLayer ?? true;

  // Render each pen layer
  for (const layer of layers) {
    if (layer.polylines.length === 0 || hiddenSet.has(layer.id)) continue;
    lines.push(
      `  <g id="layer-${escapeXml(layer.id)}" inkscape:groupmode="layer" inkscape:label="${escapeXml(layer.name)}" fill="none" stroke="${escapeXml(layer.color)}" stroke-width="${fmt(layer.strokeWidthMm)}" stroke-linecap="round" stroke-linejoin="round">`
    );

    const dSegments: string[] = [];
    for (const poly of layer.polylines) {
      if (poly.length < 2) continue;
      const d =
        "M" +
        poly.map((pt) => `${fmt(pt[0])},${fmt(pt[1])}`).join("L");
      dSegments.push(d);
    }

    if (dSegments.length > 0) {
      if (combinePaths) {
        lines.push(`    <path d="${dSegments.join(" ")}" />`);
      } else {
        for (const d of dSegments) {
          lines.push(`    <path d="${d}" />`);
        }
      }
    }

    lines.push(`  </g>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
