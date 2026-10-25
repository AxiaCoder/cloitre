/**
 * The drawings of the marker icons, by name of `marker-catalog.json`: the path
 * data of a 24×24 outline, stroked with the current text color.
 */
export const MARKER_ICON_PATHS: Readonly<Partial<Record<string, string>>> = {
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  gear:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM12 2v3M12 19v3M2 12h3M19 12h3" +
    "M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z",
  book: "M4 19V5a2 2 0 0 1 2-2h14v14H6a2 2 0 0 0-2 2zm0 0a2 2 0 0 0 2 2h14",
  flask: "M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10",
  terminal: "M4 17l6-5-6-5M12 19h8",
  database:
    "M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  cube: "M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10",
  star: "M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z",
  leaf: "M5 19C5 10 10 5 20 4c-1 10-6 15-15 15zM5 19l8-8",
  music: "M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
};

const SVG = "http://www.w3.org/2000/svg";

/**
 * Builds a 24×24 outline drawing of path data `path` as an `<svg>` element sized
 * by CSS, stroked with the current text color and hidden from assistive
 * technology. An empty `path` gives an empty drawing.
 */
export function outlineDrawing(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("marker-icon");
  const pathElement = document.createElementNS(SVG, "path");
  pathElement.setAttribute("d", path);
  svg.append(pathElement);
  return svg;
}

/**
 * Builds the drawing of icon `name`, as `outlineDrawing` does. An unknown name
 * gives an empty drawing.
 */
export function markerIcon(name: string): SVGSVGElement {
  return outlineDrawing(MARKER_ICON_PATHS[name] ?? "");
}
