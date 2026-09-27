// Builds the Yon Link phone page into src-tauri/link-dist/, which the Rust
// binary embeds with include_str! (so `cargo build` needs this to run first).
const out = "src-tauri/link-dist";

const result = await Bun.build({
  entrypoints: ["web/link.ts"],
  outdir: out,
  naming: "link.js",
  target: "browser",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const f of ["link.html", "link.css"]) await Bun.write(`${out}/${f}`, Bun.file(`web/${f}`));
console.log(`Yon Link page built into ${out}/`);
