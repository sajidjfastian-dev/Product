import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
const sourcePath = path.join(repositoryRoot, "API-SPECIFICATION.md");
const outputPath = path.join(repositoryRoot, "API-SPECIFICATION.pdf");
const source = await readFile(sourcePath, "utf8");
const document = new PDFDocument({
  size: "LETTER",
  margins: { top: 66, bottom: 56, left: 54, right: 54 },
  bufferPages: true,
  info: {
    Title: "Stockroom API Specification",
    Author: "Stockroom",
    Subject: "API endpoints, authentication, permissions, and request/response contracts",
  },
});
const output = createWriteStream(outputPath);
document.pipe(output);

function drawHeader(pageNumber) {
  const { left, right } = document.page.margins;
  document.save();
  document.font("Helvetica-Bold").fontSize(8).fillColor("#245c43")
    .text("STOCKROOM  /  API SPECIFICATION", left, 28, { lineBreak: false });
  document.font("Helvetica").fontSize(8).fillColor("#78827a")
    .text("Version 1.0", document.page.width - right - 70, 28, { width: 70, align: "right", lineBreak: false });
  document.moveTo(left, 46).lineTo(document.page.width - right, 46)
    .lineWidth(0.6).strokeColor("#dce5dc").stroke();
  document.restore();
  if (pageNumber === 1) {
    document.font("Helvetica").fontSize(8).fillColor("#78827a");
  }
}

document.on("pageAdded", () => drawHeader(document.bufferedPageRange().count + 1));
drawHeader(1);

const ascii = (value) => value
  .replace(/[“”]/g, "\"")
  .replace(/[‘’]/g, "'")
  .replace(/[–—]/g, "-")
  .replace(/…/g, "...")
  .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");

function inlineText(value) {
  return ascii(value)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>]+>/g, "");
}

function addParagraph(text, options = {}) {
  const cleaned = inlineText(text).trim();
  if (!cleaned) return;
  document.font("Helvetica").fontSize(9).fillColor("#303b33")
    .text(cleaned, { lineGap: 3, paragraphGap: 5, ...options });
}

let paragraph = [];
let codeLines = [];
let inCode = false;

function flushParagraph() {
  if (paragraph.length) addParagraph(paragraph.join(" "));
  paragraph = [];
}

function flushCode() {
  const text = ascii(codeLines.join("\n"));
  codeLines = [];
  if (!text.trim()) return;
  document.font("Courier").fontSize(7.5).fillColor("#344239")
    .text(text, {
      indent: 9,
      width: document.page.width - document.page.margins.left - document.page.margins.right - 18,
      lineGap: 1.5,
      paragraphGap: 7,
    });
  document.moveDown(0.25);
}

for (const rawLine of source.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (line.startsWith("```")) {
    flushParagraph();
    if (inCode) flushCode();
    inCode = !inCode;
    continue;
  }
  if (inCode) {
    codeLines.push(rawLine);
    continue;
  }
  if (!line || /^[-|: ]{3,}$/.test(line)) {
    flushParagraph();
    continue;
  }
  const heading = /^(#{1,3})\s+(.+)$/.exec(line);
  if (heading) {
    flushParagraph();
    const level = heading[1].length;
    document.moveDown(level === 1 ? 0.6 : 0.35);
    document.font("Helvetica-Bold")
      .fontSize(level === 1 ? 19 : level === 2 ? 13 : 10.5)
      .fillColor(level === 1 ? "#194733" : "#245c43")
      .text(inlineText(heading[2]), { lineGap: 2, paragraphGap: 5, keepWithNext: true });
    if (level === 1) document.moveDown(0.25);
    continue;
  }
  const listItem = /^[-*]\s+(.+)$/.exec(line);
  const numberedItem = /^\d+\.\s+(.+)$/.exec(line);
  if (listItem || numberedItem) {
    flushParagraph();
    const text = inlineText((listItem ?? numberedItem)[1]);
    addParagraph(`- ${text}`, { indent: 12, hanging: 4, paragraphGap: 3 });
    continue;
  }
  if (line.startsWith("|")) {
    flushParagraph();
    const cells = line.split("|").slice(1, -1).map((cell) => inlineText(cell.trim()));
    if (cells.length) addParagraph(cells.join("  |  "), { indent: 4, paragraphGap: 3 });
    continue;
  }
  if (/^---+$/.test(line)) {
    flushParagraph();
    document.moveDown(0.4);
    continue;
  }
  paragraph.push(line);
}
flushParagraph();
if (inCode) flushCode();

const pages = document.bufferedPageRange();
console.log(`Rendering ${pages.count} PDF pages.`);
for (let index = pages.start; index < pages.start + pages.count; index += 1) {
  document.switchToPage(index);
  const { left, right, bottom } = document.page.margins;
  document.save();
  document.moveTo(left, document.page.height - 52)
    .lineTo(document.page.width - right, document.page.height - 52)
    .lineWidth(0.5).strokeColor("#dce5dc").stroke();
  document.page.margins.bottom = 24;
  document.font("Helvetica").fontSize(8).fillColor("#78827a")
    .text("Current API behavior is authoritative; see API-SPECIFICATION.md for the maintained source.",
      left, document.page.height - 44, { width: document.page.width - left - right - 55, lineBreak: false });
  document.text(`Page ${index + 1}`, document.page.width - right - 48,
    document.page.height - 44, { width: 48, align: "right", lineBreak: false });
  document.page.margins.bottom = bottom;
  document.restore();
}

const finished = new Promise((resolve, reject) => {
  output.on("finish", resolve);
  output.on("error", reject);
  document.on("error", reject);
});
document.end();
await finished;
console.log(`Generated ${outputPath}`);
