import type { Html } from "@effect/ui/html"

function svgIcon<M>(h: Html.H<M>, className: string, paths: ReadonlyArray<string>) {
  return h.svg
    .class(className)
    .attrs({
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    })
    .children(paths.map((d) => h.path.attr("d", d)))
}

export const IconFolderGit = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    "M12 10v6",
    "M12 13h4",
  ])

export const IconSun = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M12 2v2",
    "M12 20v2",
    "m4.93 4.93 1.41 1.41",
    "m17.66 17.66 1.41 1.41",
    "M2 12h2",
    "M20 12h2",
    "m6.34 17.66-1.41 1.41",
    "m19.07 4.93-1.41 1.41",
  ])

export const IconMoon = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"])

export const IconSearch = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z", "m21 21-4.3-4.3"])

export const IconCpu = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, [
    "M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
    "M9 9h6v6H9z",
    "M9 1v3",
    "M15 1v3",
    "M9 20v3",
    "M15 20v3",
    "M20 9h3",
    "M20 14h3",
    "M1 9h3",
    "M1 14h3",
  ])

export const IconServer = <M>(h: Html.H<M>, cls = "size-2.5 shrink-0") =>
  svgIcon(h, cls, [
    "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z",
    "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2Z",
    "M6 6h.01",
    "M6 18h.01",
  ])

export const IconLayers = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z",
    "m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65",
    "m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65",
  ])

export const IconChevronDown = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") => svgIcon(h, cls, ["m6 9 6 6 6-6"])

export const IconChevronRight = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") => svgIcon(h, cls, ["m9 18 6-6-6-6"])

export const IconGitBranch = <M>(h: Html.H<M>, cls = "size-2.5 shrink-0") =>
  svgIcon(h, cls, [
    "M6 3v12",
    "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    "M18 9a9 9 0 0 1-9 9",
  ])

export const IconCloudUpload = <M>(h: Html.H<M>, cls = "size-2.5 shrink-0") =>
  svgIcon(h, cls, ["M12 13v8", "M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242", "m8 17 4-4 4 4"])

export const IconTerminal = <M>(h: Html.H<M>, cls = "size-3 shrink-0") => svgIcon(h, cls, ["m4 17 6-6-6-6", "M12 19h8"])

export const IconSend = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["m22 2-7 20-4-9-9-4Z", "M22 2 11 13"])

export const IconSquare = <M>(h: Html.H<M>, cls = "size-2.5 shrink-0") => svgIcon(h, cls, ["M5 5h14v14H5z"])

export const IconArchive = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M2 4h20v5H2z", "M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9", "M10 13h4"])

export const IconMessageSquare = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"])

export const IconColumns = <M>(h: Html.H<M>, cls = "size-3 shrink-0") => svgIcon(h, cls, ["M3 3h18v18H3z", "M12 3v18"])

export const IconPanelRight = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M3 3h18v18H3z", "M15 3v18"])

export const IconAtSign = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"])

export const IconBot = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, ["M12 8V4H8", "M4 8h16v12H4z", "M2 14h2", "M20 14h2", "M15 13v2", "M9 13v2"])

export const IconSparkles = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z",
  ])

export const IconFileText = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M10 9H8",
    "M16 13H8",
    "M16 17H8",
  ])

export const IconFileCode = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "m10 13-2 2 2 2",
    "m14 17 2-2-2-2",
  ])

export const IconFileImage = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "m20 17-3.5-3.5a2 2 0 0 0-2.8 0L7 20",
  ])

export const IconFilm = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, ["M4 3h16v18H4z", "M8 3v18", "M16 3v18", "M4 12h16"])

export const IconPackage = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, [
    "m16.5 9.4-9-5.19",
    "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z",
    "M3.3 7 12 12l8.7-5",
    "M12 22V12",
  ])

export const IconBookOpen = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"])

export const IconBrain = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, [
    "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z",
    "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z",
  ])

export const IconSliders = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") =>
  svgIcon(h, cls, [
    "M21 4h-7",
    "M10 4H3",
    "M21 12h-9",
    "M8 12H3",
    "M21 20h-5",
    "M12 20H3",
    "M14 2v4",
    "M8 10v4",
    "M16 18v4",
  ])

export const IconX = <M>(h: Html.H<M>, cls = "size-3.5 shrink-0") => svgIcon(h, cls, ["M18 6 6 18", "m6 6 12 12"])

export const IconRefresh = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, [
    "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8",
    "M21 3v5h-5",
    "M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16",
    "M8 16H3v5",
  ])

export const IconMaximize = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"])

export const IconHand = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, [
    "M18 11V6a2 2 0 0 0-4 0v4",
    "M14 10V4a2 2 0 0 0-4 0v6",
    "M10 10.5V6a2 2 0 0 0-4 0v8",
    "M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15",
  ])

export const IconCrosshair = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M22 12h-4", "M6 12H2", "M12 6V2", "M12 22v-4"])

export const IconCircle = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"])

export const IconBox = <M>(h: Html.H<M>, cls = "size-3 shrink-0") => svgIcon(h, cls, ["M4 4h16v16H4z"])

export const IconPlusCircle = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M8 12h8", "M12 8v8"])

export const IconSave = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z", "M17 21v-8H7v8", "M7 3v5h8"])

export const IconMessagePlus = <M>(h: Html.H<M>, cls = "size-3 shrink-0") =>
  svgIcon(h, cls, ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", "M12 7v6", "M9 10h6"])
