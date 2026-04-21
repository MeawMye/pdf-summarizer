const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();

const DEFAULT_STORAGE_ROOT = path.join(__dirname, 'storage');
const STORAGE_ROOT = process.env.STORAGE_ROOT || DEFAULT_STORAGE_ROOT;
const CONFIG = {
  port: parseInt(process.env.PORT || '3001', 10),
  storageRoot: STORAGE_ROOT,
  localModelRoot: process.env.LOCAL_MODEL_ROOT || '',
  uploadDir: process.env.UPLOAD_DIR || path.join(STORAGE_ROOT, 'uploads'),
  embeddingsDir: process.env.EMBEDDINGS_DIR || path.join(STORAGE_ROOT, 'embeddings'),
  extractorApiUrl: process.env.EXTRACTOR_LLM_API_URL || process.env.LOCAL_LLM_API_URL || 'http://127.0.0.1:5000/v1/chat/completions',
  plannerApiUrl: process.env.PLANNER_LLM_API_URL || process.env.LOCAL_LLM_API_URL || 'http://127.0.0.1:5000/v1/chat/completions',
  embeddingApiUrl: process.env.EMBEDDING_API_URL || '',
  extractorModel: process.env.EXTRACTOR_LLM_MODEL || 'knowledge-extractor',
  plannerModel: process.env.PLANNER_LLM_MODEL || 'sequence-planner',
  embeddingModel: process.env.EMBEDDING_MODEL || 'local-embedding-model',
  defaultAiTimeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '120000', 10),
  sourceFaithfulMode: String(process.env.SOURCE_FAITHFUL_MODE || 'true').toLowerCase() === 'true'
};

let activePort = null;
let pdfjsLib;

ensureDirectory(CONFIG.storageRoot);
ensureDirectory(CONFIG.uploadDir);
ensureDirectory(CONFIG.embeddingsDir);

const upload = multer({ dest: CONFIG.uploadDir });

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

async function loadPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }

  return pdfjsLib;
}

function sanitizeFileName(name) {
  return name.replace(/[^a-zA-Z0-9-_]/g, '_');
}

function buildArtifactName(fileName, suffix) {
  const baseName = sanitizeFileName(path.parse(fileName).name || 'document');
  return `${Date.now()}-${baseName}-${suffix}.json`;
}

async function extractPageRange(dataBuffer, startPage, endPage) {
  const pdfjs = await loadPdfJs();
  const uint8Data = new Uint8Array(dataBuffer);
  const loadingTask = pdfjs.getDocument({ data: uint8Data });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;

  const actualStartPage = Math.max(1, startPage || 1);
  const actualEndPage = Math.min(endPage || totalPages, totalPages);

  if (actualStartPage > totalPages) {
    throw new Error(`Invalid startPage. PDF has ${totalPages} pages.`);
  }

  if (actualEndPage < actualStartPage) {
    throw new Error('endPage must be greater than or equal to startPage');
  }

  let extractedText = '';
  for (let pageNum = actualStartPage; pageNum <= actualEndPage; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const lines = [];
    let currentLine = [];
    let currentY = null;

    for (const item of content.items) {
      const str = (item.str || '').trim();
      if (!str) {
        continue;
      }

      const y = Array.isArray(item.transform) ? item.transform[5] : null;
      const isNewLine = currentY !== null && y !== null && Math.abs(y - currentY) > 2;

      if (isNewLine && currentLine.length > 0) {
        lines.push(currentLine.join(' ').replace(/\s{2,}/g, ' ').trim());
        currentLine = [];
      }

      currentLine.push(str);
      if (y !== null) {
        currentY = y;
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine.join(' ').replace(/\s{2,}/g, ' ').trim());
    }

    const pageText = lines.join('\n');
    extractedText += `${pageText}\n\n`;
  }

  return { extractedText, totalPages, actualStartPage, actualEndPage };
}

function isLikelySectionHeading(line) {
  if (!line || line.length < 4) {
    return false;
  }

  if (/^\d+(\.\d+)*\s+/.test(line)) {
    return true;
  }

  if (/^[A-Z][A-Za-z0-9\-(),\s]{3,80}$/.test(line) && !line.endsWith('.')) {
    return true;
  }

  if (/^(chapter|section|appendix|overview|introduction|exception handling|types of exception)\b/i.test(line)) {
    return true;
  }

  return false;
}

function buildSourceFaithfulSectionOutput(text) {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const sections = [];
  let current = null;
  const tableBlocks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^Table\s+\d+(\.\d+)*/i.test(line)) {
      const block = [line];
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        if (isLikelySectionHeading(lines[j])) {
          break;
        }
        block.push(lines[j]);
      }
      tableBlocks.push(block.join('\n'));
    }

    if (isLikelySectionHeading(line)) {
      if (current && current.body.length > 0) {
        sections.push(current);
      }
      current = { title: line, body: [] };
      continue;
    }

    if (!current) {
      current = { title: 'Document Overview', body: [] };
    }
    current.body.push(line);
  }

  if (current && current.body.length > 0) {
    sections.push(current);
  }

  const summaryLines = ['- Section Outline (source-faithful)'];
  const extractedLines = ['- Detected Sections'];

  const limitedSections = sections.slice(0, 10);
  for (const section of limitedSections) {
    summaryLines.push('');
    summaryLines.push(`- ${section.title}`);
    const snippets = section.body.slice(0, 4);
    for (const snippet of snippets) {
      summaryLines.push(`  - ${snippet}`);
    }
    extractedLines.push(`- ${section.title}`);
  }

  if (tableBlocks.length > 0) {
    summaryLines.push('');
    summaryLines.push('- Table Excerpts (source-faithful)');
    for (const block of tableBlocks.slice(0, 4)) {
      summaryLines.push('');
      summaryLines.push(block);
    }
  }

  if (limitedSections.length === 0) {
    summaryLines.push('');
    summaryLines.push('- Document Overview');
    for (const line of lines.slice(0, 12)) {
      summaryLines.push(`  - ${line}`);
    }
  }

  return {
    summary: summaryLines.join('\n').trim(),
    extractedKnowledge: extractedLines.join('\n').trim(),
    summaryMode: 'source-faithful-section-outline'
  };
}

function extractProgrammingFocusedText(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  const keywords = [
    'step', 'steps', 'install', 'setup', 'configure', 'configuration',
    'api', 'endpoint', 'command', 'example', 'code', 'function', 'class',
    'dependency', 'requirement', 'version', 'parameter', 'option',
    'node', 'npm', 'express', 'pdf', 'upload', 'parse',
    'procedure', 'sequence', 'initialize', 'build', 'run',
    'flow', 'pipeline', 'request', 'response', 'schema', 'prompt',
    '설치', '설정', '구성', '순서', '단계', '명령어', '옵션', '주의', '요구사항', '의존성', '처리', '절차'
  ];

  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 25);

  const scored = sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
      if (lower.includes(keyword)) {
        score += 3;
      }
    }

    if (/npm|node|express|api|http|json|curl|--|\.js|\(|\)|\{|\}|\[|\]|=/.test(lower)) {
      score += 4;
    }

    if (/introduction|general information|reference|applicable products|table\s+\d+/i.test(lower)) {
      score -= 4;
    }

    return { sentence, score, index };
  });

  const selected = scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence);

  const focused = selected.join('\n');
  return focused.length > 5000 ? focused.slice(0, 5000) : focused;
}

function summarizeText(text) {
  if (!text || text.trim().length === 0) {
    return '';
  }

  const stopwords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'were', 'which', 'their', 'also', 'are', 'was', 'but', 'not', 'you', 'your', 'can', 'all', 'any', 'one', 'use', 'using', 'used', 'will', 'should', 'may', 'such', 'into', 'more', 'other', 'than', 'then', 'when', 'what', 'where', 'who', 'how', 'its', 'it', 'is', 'of', 'on', 'in', 'to', 'a', 'an'
  ]);

  const sentences = text
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 20);

  if (sentences.length <= 3) {
    return sentences.join(' ');
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopwords.has(word));

  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  const sentenceScores = sentences.map((sentence) => {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const sentenceWords = normalized.split(/\s+/).filter((word) => word.length > 2);
    let score = 0;

    for (const word of sentenceWords) {
      if (freq[word]) {
        score += freq[word];
      }
    }

    return { sentence, score };
  });

  return sentenceScores
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, sentenceScores.length))
    .map((item) => item.sentence)
    .join(' ');
}

function postProcessSummary(summary) {
  if (!summary || typeof summary !== 'string') {
    return '';
  }

  const lines = summary
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const cleaned = [];
  const seen = new Set();

  for (let line of lines) {
    line = line
      .replace(/^[-*•]\s*/, '- ')
      .replace(/^\d+[.)]\s*/, '- ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const normalizedForDup = line
      .toLowerCase()
      .replace(/[\s`*_~]/g, '')
      .replace(/[^a-z0-9가-힣:.-]/g, '');

    if (!normalizedForDup || normalizedForDup.length < 4 || seen.has(normalizedForDup)) {
      continue;
    }

    seen.add(normalizedForDup);
    cleaned.push(line);
  }

  const sectionHeaderPattern = /^-\s*(Development Setup|Core Workflow|Shared Steps|Target Mapping|Required Settings\/Commands|Validation Checklist|Cautions|Key Concepts|Required Settings\/Commands\/API|Constraints)/;
  const formatted = [];

  for (const line of cleaned) {
    const isSectionHeader = sectionHeaderPattern.test(line);
    if (isSectionHeader && formatted.length > 0) {
      const prev = formatted[formatted.length - 1];
      if (prev !== '') {
        formatted.push('');
      }
    }

    formatted.push(line);
  }

  return formatted.join('\n').trim();
}

function uniqueTop(items, limit = 10) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const normalized = item.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

function collectActionableSignals(text) {
  const functionMatches = text.match(/\b[A-Za-z_][A-Za-z0-9_]*\s*\(\)/g) || [];
  const acronymMatches = text.match(/\b(?:SVC|HVC|SMC|IRQ|FIQ|MMU|LTDC|API|SDK|CMSIS|HAL)\b/g) || [];
  const toolMatches = text.match(/\b(?:STM32CubeMX|STM32|ARM Cortex-[ARMv0-9A-Za-z.-]+|Vector Table(?:s)?)\b/g) || [];
  const targetMatches = text.match(/\b(?:Exception|Handler|Abort|Supervisor|User mode|Privileged mode|Secure|Non-secure|PL1|PL2|Monitor)\b/gi) || [];

  return {
    tools: uniqueTop(toolMatches, 6),
    functionsAndApis: uniqueTop([...functionMatches, ...acronymMatches], 10),
    targets: uniqueTop(targetMatches, 10)
  };
}

function buildActionableBrief(text) {
  const signals = collectActionableSignals(text);

  const toolText = signals.tools.length > 0 ? signals.tools.join(', ') : 'No explicit tools/environment found in source';
  const fnText = signals.functionsAndApis.length > 0 ? signals.functionsAndApis.join(', ') : 'No explicit functions/APIs found in source';
  const targetText = signals.targets.length > 0 ? signals.targets.join(', ') : 'No explicit Handler/Exception/Mode found in source';

  return [
    '- Development Setup',
    `- Tools/Environment: ${toolText}`,
    `- Required Functions/APIs: ${fnText}`,
    `- Applicable Targets (Handler/Exception/Mode): ${targetText}`
  ].join('\n');
}

function buildFallbackExecutionPlan(text) {
  const signals = collectActionableSignals(text);
  const targets = signals.targets.length > 0 ? signals.targets : ['Exception', 'Handler'];
  const apis = signals.functionsAndApis.length > 0 ? signals.functionsAndApis : ['SVC', 'IRQ', 'FIQ'];

  const commonTasks = [
    '- Shared Steps (deduplicated)',
    '- Save processor state and return address',
    '- Define mode transition rules on exception entry',
    '- Define exception return procedure and validation checks'
  ];

  const targetMappings = ['- Target Mapping'];
  for (const target of targets.slice(0, 6)) {
    targetMappings.push(`- ${target}: apply Shared Steps 1-3`);
  }

  return [
    '- Core Workflow',
    '- Define the exception handling flow',
    '- Define entry conditions for each Handler/Exception/Mode',
    '- Define each repeated step once and map it to targets',
    '',
    ...commonTasks,
    '',
    ...targetMappings,
    '',
    '- Required Settings/Commands',
    `- ${apis.slice(0, 8).join(', ')}`,
    '',
    '- Cautions',
    '- Do not add any function/API/command not present in the source',
    '- Keep technical terms exactly as written in the source'
  ].join('\n');
}

function ensureActionableSummary(summary, sourceText) {
  const normalized = postProcessSummary(summary);
  const hasActionableHeader = /-\s*Development Setup/.test(normalized);
  if (hasActionableHeader) {
    return normalized;
  }

  const actionableBrief = buildActionableBrief(sourceText);
  return `${actionableBrief}\n\n${normalized}`.trim();
}

async function callLocalChat({ apiUrl, modelName, systemPrompt, userPrompt, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: maxTokens
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`LLM API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error('LLM API returned an empty response');
  }

  return content;
}

async function runLayeredPipeline(text, timeoutMs) {
  const focusedText = extractProgrammingFocusedText(text);
  const clippedText = (focusedText || text).slice(0, 5000);
  const actionableBrief = buildActionableBrief(clippedText);

  const extractedKnowledge = await callLocalChat({
    apiUrl: CONFIG.extractorApiUrl,
    modelName: CONFIG.extractorModel,
    systemPrompt: [
      'You extract only implementation-critical information from technical documents.',
      'Output in English only.',
      'Do not translate, paraphrase, or alter technical terms from the source.',
      'Keep function names, API names, mode names, handler names, and commands exactly as in source text.',
      'Do not invent any function/API/command not explicitly present in source.'
    ].join(' '),
    userPrompt: [
      'Extract implementation-ready information for programmers from the source text below.',
      'Output format must use exactly these 4 sections in English:',
      '1) Development Setup: tools/environment/required functions/APIs/special settings (3-8 bullets)',
      '2) Key Concepts: 3-6 bullets',
      '3) Required Settings/Commands/API: 3-10 bullets from source only',
      '4) Constraints: 2-5 bullets',
      'All output must be English and source-faithful.',
      '',
      '[Detected actionable signals from source]',
      actionableBrief,
      '',
      clippedText
    ].join('\n'),
    maxTokens: 420,
    timeoutMs
  });

  const plannedSequence = await callLocalChat({
    apiUrl: CONFIG.plannerApiUrl,
    modelName: CONFIG.plannerModel,
    systemPrompt: [
      'You are a planning model that converts extracted technical facts into an executable implementation plan.',
      'Output in English only.',
      'Keep technical terms exactly as in source text.',
      'If deduplication is uncertain, prioritize a clear handler-by-handler listing instead of forced dedup.',
      'Do not invent any function/API/command not present in source.'
    ].join(' '),
    userPrompt: [
      'Create an implementation plan from the extracted results below.',
      'Output format (English, fixed headings):',
      '1) Development Setup',
      '2) Core Workflow',
      '3) Shared Steps (deduplicated) OR Handler-by-Handler Steps (if dedup is unclear)',
      '4) Target Mapping',
      '5) Required Settings/Commands',
      '6) Validation Checklist',
      '7) Cautions',
      'Rules:',
      '- Keep source meaning unchanged',
      '- Keep technical terms exactly as in source',
      '- If repeated tasks are hard to deduplicate safely, list by each handler clearly',
      '',
      '[Detected actionable signals from source]',
      actionableBrief,
      '',
      '[Source excerpt]',
      clippedText,
      '',
      extractedKnowledge
    ].join('\n'),
    maxTokens: 560,
    timeoutMs
  });

  return {
    extractedKnowledge: ensureActionableSummary(extractedKnowledge, clippedText),
    executionPlan: ensureActionableSummary(plannedSequence, clippedText)
  };
}

function chunkTextForEmbeddings(text, maxChunkLength = 1200) {
  const segments = text
    .replace(/\r\n/g, '\n')
    .split(/\n+/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return [];
  }

  const chunks = [];
  let current = '';
  for (const segment of segments) {
    const candidate = current ? `${current}\n${segment}` : segment;
    if (candidate.length > maxChunkLength && current) {
      chunks.push(current);
      current = segment;
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

async function createEmbeddings(inputs, timeoutMs) {
  if (!CONFIG.embeddingApiUrl) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(CONFIG.embeddingApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: CONFIG.embeddingModel,
        input: inputs
      })
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding API error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const embeddings = data?.data?.map((item) => item.embedding);
  if (!embeddings || embeddings.length !== inputs.length) {
    throw new Error('Embedding API returned an unexpected payload');
  }

  return embeddings;
}

async function generateAndStoreEmbeddings({ fileName, processedPages, sourceText, extractedKnowledge, executionPlan, timeoutMs }) {
  if (!CONFIG.embeddingApiUrl) {
    return { status: 'skipped', reason: 'EMBEDDING_API_URL not configured' };
  }

  const embeddingSource = [
    extractedKnowledge ? `EXTRACTED\n${extractedKnowledge}` : '',
    executionPlan ? `PLAN\n${executionPlan}` : '',
    sourceText ? `SOURCE\n${sourceText}` : ''
  ].filter(Boolean).join('\n\n');

  const chunks = chunkTextForEmbeddings(embeddingSource);
  if (chunks.length === 0) {
    return { status: 'skipped', reason: 'No content available for embeddings' };
  }

  const vectors = await createEmbeddings(chunks, timeoutMs);
  const artifactName = buildArtifactName(fileName, 'embeddings');
  const artifactPath = path.join(CONFIG.embeddingsDir, artifactName);

  const payload = {
    createdAt: new Date().toISOString(),
    fileName,
    processedPages,
    storageRoot: CONFIG.storageRoot,
    localModelRoot: CONFIG.localModelRoot || null,
    extractorModel: CONFIG.extractorModel,
    plannerModel: CONFIG.plannerModel,
    embeddingModel: CONFIG.embeddingModel,
    chunkCount: chunks.length,
    items: chunks.map((chunk, index) => ({
      index,
      text: chunk,
      embedding: vectors[index]
    }))
  };

  fs.writeFileSync(artifactPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    status: 'stored',
    artifactFile: artifactName,
    artifactPath,
    chunkCount: chunks.length
  };
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activePort,
    storageRoot: CONFIG.storageRoot,
    localModelRoot: CONFIG.localModelRoot || null,
    uploadDir: CONFIG.uploadDir,
    embeddingsDir: CONFIG.embeddingsDir,
    extractorApiUrl: CONFIG.extractorApiUrl,
    plannerApiUrl: CONFIG.plannerApiUrl,
    embeddingApiConfigured: Boolean(CONFIG.embeddingApiUrl)
  });
});

app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const dataBuffer = fs.readFileSync(req.file.path);
    const startPage = req.query.startPage ? parseInt(req.query.startPage, 10) : null;
    const endPage = req.query.endPage ? parseInt(req.query.endPage, 10) : null;
    const useAI = String(req.query.useAI || '').toLowerCase() === 'true';
    const aiTimeoutSec = req.query.aiTimeoutSec ? parseInt(req.query.aiTimeoutSec, 10) : null;
    const aiTimeoutMs = Number.isFinite(aiTimeoutSec) && aiTimeoutSec > 0
      ? aiTimeoutSec * 1000
      : CONFIG.defaultAiTimeoutMs;
    const generateEmbeddings = String(req.query.generateEmbeddings || (useAI ? 'true' : 'false')).toLowerCase() === 'true';

    const result = await extractPageRange(dataBuffer, startPage, endPage);
    const processedText = result.extractedText;
    const totalPages = result.totalPages;
    const actualStartPage = result.actualStartPage;
    const actualEndPage = result.actualEndPage;
    const processedPages = `${actualStartPage}-${actualEndPage}`;

    let summary;
    let extractedKnowledge = null;
    let summaryMode = 'extractive';
    let embeddingInfo = { status: 'disabled' };

    if (useAI) {
      try {
        if (CONFIG.sourceFaithfulMode) {
          const sectioned = buildSourceFaithfulSectionOutput(processedText);
          extractedKnowledge = sectioned.extractedKnowledge;
          summary = sectioned.summary;
          summaryMode = sectioned.summaryMode;
        } else {
          const pipeline = await runLayeredPipeline(processedText, aiTimeoutMs);
          extractedKnowledge = pipeline.extractedKnowledge;
          summary = pipeline.executionPlan;
          summaryMode = 'local-llm-pipeline';
        }
      } catch (aiError) {
        console.error('Layered local AI pipeline failed, falling back:', aiError.message);
        const sectioned = buildSourceFaithfulSectionOutput(processedText);
        extractedKnowledge = sectioned.extractedKnowledge;
        summary = sectioned.summary;
        summaryMode = 'source-faithful-fallback';
      }
    } else {
      const sectioned = buildSourceFaithfulSectionOutput(processedText);
      extractedKnowledge = sectioned.extractedKnowledge;
      summary = sectioned.summary;
      summaryMode = sectioned.summaryMode;
    }

    if (generateEmbeddings) {
      try {
        embeddingInfo = await generateAndStoreEmbeddings({
          fileName: req.file.originalname,
          processedPages,
          sourceText: processedText,
          extractedKnowledge,
          executionPlan: summary,
          timeoutMs: aiTimeoutMs
        });
      } catch (embeddingError) {
        console.error('Embedding generation failed:', embeddingError.message);
        embeddingInfo = {
          status: 'failed',
          reason: embeddingError.message
        };
      }
    }

    fs.unlinkSync(req.file.path);

    res.json({
      summary,
      extractedKnowledge,
      summaryMode,
      totalPages,
      processedPages,
      fileName: req.file.originalname,
      textLength: processedText.length,
      wordCount: processedText.split(/\s+/).filter((word) => word.length > 0).length,
      storage: {
        storageRoot: CONFIG.storageRoot,
        embeddingsDir: CONFIG.embeddingsDir,
        localModelRoot: CONFIG.localModelRoot || null
      },
      embeddingInfo
    });
  } catch (error) {
    console.error(error);

    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    if (error.message && error.message.startsWith('Invalid')) {
      return res.status(400).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to process PDF', details: error.message });
  }
});

function startServer(port) {
  const server = app.listen(port, () => {
    activePort = port;
    console.log(`Server running on http://localhost:${port}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Retrying on ${nextPort}...`);
      startServer(nextPort);
      return;
    }

    console.error('Failed to start server:', error);
    process.exit(1);
  });
}

startServer(CONFIG.port);
