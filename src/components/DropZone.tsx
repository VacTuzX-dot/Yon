import type { ReactNode } from "react";
import { plural } from "../files";

interface Props {
  /** Files and folders are over the window. */
  dragging: { files: number; folders: number } | null;
  /** Name of the device under the pointer, if any. */
  target: string | null;
  children: ReactNode;
}

/** The device area turns into a drop target while files are dragged over
 *  the window: tinted, dashed accent edge, a slight lift, and a label with
 *  the count. The device under the pointer is highlighted by DeviceOrbit. */
export default function DropZone({ dragging, target, children }: Props) {
  const on = dragging !== null;
  const what = dragging
    ? [
        dragging.folders > 0 && plural(dragging.folders, "folder"),
        dragging.files > 0 && plural(dragging.files, "file"),
      ]
        .filter(Boolean)
        .join(" and ")
    : "";
  // WHY: over a device, say exactly where the files will go.
  const label =
    dragging === null
      ? ""
      : target
        ? `Drop to send to ${target}`
        : `Drop ${what || "here"} on a device`;

  return (
    <div
      className={[
        "relative flex w-full max-w-[760px] flex-col items-center rounded-[28px] border-2 border-dashed px-4 py-5",
        "transition-[background-color,border-color,transform] duration-200 ease-snappy",
        on
          ? "border-accent/70 bg-accent/5"
          : "border-transparent",
      ].join(" ")}
    >
      <div
        role="status"
        aria-live="polite"
        className={[
          "pointer-events-none absolute -top-4 left-1/2 flex -translate-x-1/2 items-center gap-2",
          "rounded-full border border-accent bg-surface px-4 py-1.5 text-sm font-semibold whitespace-nowrap",
          "text-ink",
          "transition-[opacity,transform] duration-200 ease-snappy",
          on ? "opacity-100" : "opacity-0 motion-safe:translate-y-1",
        ].join(" ")}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden
          className={[
            "size-4 fill-none stroke-accent stroke-2 [stroke-linecap:round] [stroke-linejoin:round]",
            on ? "motion-safe:animate-bounce" : "",
          ].join(" ")}
        >
          <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
        </svg>
        {label}
      </div>
      {children}
    </div>
  );
}
