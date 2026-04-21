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
  defaultAiTimeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '120000', 10)
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
    const pageText = content.items.map((item) => item.str).join(' ');
    extractedText += `${pageText}\n`;
  }

  return { extractedText, totalPages, actualStartPage, actualEndPage };
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

  return cleaned.join('\n').trim();
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

  const extractedKnowledge = await callLocalChat({
    apiUrl: CONFIG.extractorApiUrl,
    modelName: CONFIG.extractorModel,
    systemPrompt: [
      '너는 기술 문서에서 구현에 직접 필요한 정보만 추출하는 모델이다.',
      '영어 기술어(함수명, API명, 모드명, 핸들러명, 명령어)는 절대 번역/의역하지 말고 원문 그대로 유지한다.',
      '원문에 없는 함수/API/명령어를 새로 만들지 않는다.',
      '법적 고지, 회사 소개, 마케팅 문구는 제거한다.'
    ].join(' '),
    userPrompt: [
      '아래 문서에서 프로그래머가 구현에 바로 쓰는 정보만 추출해 주세요.',
      '출력 형식은 반드시 아래 4개 섹션만 사용하세요.',
      '1) 개발 준비 요약(최우선): 필요한 개발도구/환경/필수 함수/API/특이 설정 3~8개',
      '2) 핵심 개념: 구현에 필요한 개념 3~6개',
      '3) 필요한 설정/명령어/API: 원문에 있는 값만 3~10개',
      '4) 주의사항/제약조건: 실패 방지 포인트 2~5개',
      '영어 기술어는 반드시 원문 그대로 유지하세요.',
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
      '너는 추출된 기술 정보를 구현 계획으로 재구성하는 계획 모델이다.',
      '영어 기술어(함수명, API명, 모드명, 핸들러명)는 원문 그대로 유지한다.',
      '중복 작업이 여러 대상에 반복되면, 작업은 1회만 기술하고 적용 대상을 매핑해서 보여준다.',
      '원문 근거 없는 새 함수/API/명령어를 만들지 않는다.'
    ].join(' '),
    userPrompt: [
      '아래 추출 결과를 기반으로 실제 작업 순서를 만들어 주세요.',
      '출력 형식(고정):',
      '1) 개발 준비 요약',
      '2) 핵심 작업 순서',
      '3) 공통 작업(중복 제거): 반복되는 작업만 모아서 한 번만 작성',
      '4) 적용 대상 매핑: 각 공통 작업이 적용되는 Handler/Exception/Mode 목록',
      '5) 필수 설정/명령어',
      '6) 주의사항',
      '규칙:',
      '- 동일 작업 문장을 반복하지 말 것',
      '- 작업은 한 번, 적용 대상은 별도 매핑',
      '- 영어 기술어 원문 유지',
      '',
      extractedKnowledge
    ].join('\n'),
    maxTokens: 560,
    timeoutMs
  });

  return {
    extractedKnowledge: postProcessSummary(extractedKnowledge),
    executionPlan: postProcessSummary(plannedSequence)
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
        const pipeline = await runLayeredPipeline(processedText, aiTimeoutMs);
        extractedKnowledge = pipeline.extractedKnowledge;
        summary = pipeline.executionPlan;
        summaryMode = 'local-llm-pipeline';
      } catch (aiError) {
        console.error('Layered local AI pipeline failed, falling back:', aiError.message);
        summary = summarizeText(processedText);
        summaryMode = 'extractive-fallback';
      }
    } else {
      summary = summarizeText(processedText);
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
