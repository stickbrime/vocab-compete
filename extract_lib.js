// Shared text extraction utilities for PDF / DOCX / plain text.
// Loaded by both extract.html and index.html.
// Depends on pdf.js (pdfjsLib) and JSZip being loaded before this file.

async function extractTextFromFile(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const ext = file.name.split('.').pop().toLowerCase();
  const isPdf = (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) || ext === 'pdf';
  const isZip = (head[0] === 0x50 && head[1] === 0x4B) || ext === 'docx';
  if (isPdf) return await extractPdfText(file);
  if (isZip)  return await extractDocxText(file);
  // Plain text — reject obvious binary
  const probe = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
  let binary = 0;
  for (let i = 0; i < probe.length; i++) if (probe[i] === 0) binary++;
  if (binary > 4) throw new Error('文件像是二进制格式，请改用 .txt，或上传 PDF / DOCX');
  return await file.text();
}

async function extractPdfText(file) {
  if (typeof pdfjsLib === 'undefined') {
    throw new Error('PDF 解析库未加载（CDN 失败或离线），请改用 .txt 文件');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const ab = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Collect all text items with x, y
    const items = [];
    let maxX = 0;
    for (const item of content.items) {
      const x = item.transform[4];
      const y = Math.round(item.transform[5]);
      if (x > maxX) maxX = x;
      items.push({ x, y, str: item.str });
    }
    if (items.length === 0) continue;

    // Detect 2-column layout: find a gap in x-coordinates
    // Group items by rounded x, find the biggest gap
    const xSet = new Set(items.map(it => Math.round(it.x / 10) * 10));
    const xVals = Array.from(xSet).sort((a, b) => a - b);
    let colSplit = -1;
    let maxGap = 0;
    for (let k = 1; k < xVals.length; k++) {
      const gap = xVals[k] - xVals[k - 1];
      if (gap > maxGap) { maxGap = gap; colSplit = (xVals[k] + xVals[k - 1]) / 2; }
    }
    const twoColumn = maxGap > 50; // gap > 50px suggests 2 columns

    // Group into lines by y-coordinate
    const lines = new Map();
    for (const item of items) {
      let key = item.y;
      for (const k of lines.keys()) {
        if (Math.abs(k - item.y) <= 2) { key = k; break; }
      }
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push(item);
    }
    const sortedY = Array.from(lines.keys()).sort((a, b) => b - a);

    if (twoColumn) {
      // Output left column first (all lines), then right column
      let leftText = '', rightText = '';
      for (const y of sortedY) {
        const lineItems = lines.get(y).sort((a, b) => a.x - b.x);
        const leftParts = lineItems.filter(it => it.x < colSplit).map(it => it.str);
        const rightParts = lineItems.filter(it => it.x >= colSplit).map(it => it.str);
        if (leftParts.length) leftText += leftParts.join('') + '\n';
        if (rightParts.length) rightText += rightParts.join('') + '\n';
      }
      text += leftText + rightText;
    } else {
      // Single column: just sort by y then x
      for (const y of sortedY) {
        const parts = lines.get(y).sort((a, b) => a.x - b.x).map(it => it.str).join('');
        text += parts + '\n';
      }
    }
  }
  return text;
}

async function extractDocxText(file) {
  if (typeof JSZip === 'undefined') {
    throw new Error('DOCX 解析库未加载（CDN 失败或离线），请改用 .txt 文件');
  }
  const ab = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(ab);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('不是有效的 .docx（缺少 word/document.xml）');
  const xml = await docFile.async('text');
  return xml
    .replace(/<w:p\b[^>]*>/g, '\n')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
