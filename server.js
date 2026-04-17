const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });
const LOCAL_LLM_API_URL = process.env.LOCAL_LLM_API_URL || 'http://127.0.0.1:5000/v1/chat/completions';

// Ensure uploads directory exists
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

let pdfjsLib;
async function loadPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return pdfjsLib;
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
    const pageText = content.items.map(item => item.str).join(' ');
    extractedText += pageText + '\n';
  }

  return { extractedText, totalPages, actualStartPage, actualEndPage };
}

app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    const dataBuffer = fs.readFileSync(req.file.path);
    const startPage = req.query.startPage ? parseInt(req.query.startPage, 10) : null;
    const endPage = req.query.endPage ? parseInt(req.query.endPage, 10) : null;
    const useAI = String(req.query.useAI || '').toLowerCase() === 'true';
    const aiTimeoutSec = req.query.aiTimeoutSec ? parseInt(req.query.aiTimeoutSec, 10) : 120;
    const aiTimeoutMs = Number.isFinite(aiTimeoutSec) && aiTimeoutSec > 0 ? aiTimeoutSec * 1000 : 120000;

    const result = await extractPageRange(dataBuffer, startPage, endPage);
    const processedText = result.extractedText;
    const totalPages = result.totalPages;
    const actualStartPage = result.actualStartPage;
    const actualEndPage = result.actualEndPage;

    let summary;
    let summaryMode = 'extractive';
    if (useAI) {
      try {
        summary = await summarizeWithLocalAI(processedText, aiTimeoutMs);
        summaryMode = 'local-llm';
      } catch (aiError) {
        console.error('Local AI summarization failed, falling back:', aiError.message);
        summary = summarizeText(processedText);
        summaryMode = 'extractive-fallback';
      }
    } else {
      summary = summarizeText(processedText);
    }

    fs.unlinkSync(req.file.path);

    res.json({
      summary,
      summaryMode,
      totalPages,
      processedPages: `${actualStartPage}-${actualEndPage}`,
      fileName: req.file.originalname,
      textLength: processedText.length,
      wordCount: processedText.split(/\s+/).filter(w => w.length > 0).length
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
    '설치', '설정', '구성', '순서', '단계', '명령어', '옵션', '주의', '요구사항', '의존성'
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
  return focused.length > 4500 ? focused.slice(0, 4500) : focused;
}

async function summarizeWithLocalAI(text, timeoutMs = 120000) {
  const focusedText = extractProgrammingFocusedText(text);
  const clippedText = (focusedText || text).slice(0, 4500);
  const prompt = [
    '아래 텍스트에서 프로그래밍에 직접 필요한 정보만 한국어로 요약해 주세요.',
    '제품 소개, 회사 설명, 일반 배경지식, 표/목차 나열은 제외하세요.',
    '반드시 아래 형식을 지켜 작성하세요.',
    '1) 핵심 작업 순서: 번호 목록 3~6개',
    '2) 필수 설정/명령어: bullet 3~6개 (명령어/키워드는 가능한 경우 백틱으로)',
    '3) 주의사항: bullet 최대 3개',
    '과장 없이 원문 근거가 있는 내용만 작성하세요.',
    '',
    clippedText
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(LOCAL_LLM_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'local-model',
        messages: [
          {
            role: 'system',
            content: '너는 기술 문서에서 구현 순서와 설정 정보를 추출해 간결하게 요약하는 어시스턴트다.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: 0.2,
        max_tokens: 220
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
  const aiSummary = data?.choices?.[0]?.message?.content?.trim();

  if (!aiSummary) {
    throw new Error('LLM API returned an empty summary');
  }

  return postProcessSummary(aiSummary);
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

    if (!normalizedForDup) {
      continue;
    }

    // Skip very short, low-information lines
    if (normalizedForDup.length < 4) {
      continue;
    }

    // Remove empty section markers like "3) 주의사항:" with no content following
    if (/^\d+\)\s*.+:\s*$/i.test(line)) {
      cleaned.push(line);
      continue;
    }

    if (seen.has(normalizedForDup)) {
      continue;
    }

    seen.add(normalizedForDup);
    cleaned.push(line);
  }

  // Ensure bullet-like consistency for content lines under sections
  const normalized = cleaned.map((line, idx) => {
    if (/^\d+\)\s*.+:\s*$/i.test(line)) {
      return line;
    }

    if (idx > 0 && /^\d+\)\s*.+:\s*$/i.test(cleaned[idx - 1])) {
      return line.startsWith('- ') ? line : `- ${line}`;
    }

    return line;
  });

  return normalized.join('\n').trim();
}

function summarizeText(text) {
  if (!text || text.trim().length === 0) {
    return '';
  }

  const stopwords = new Set([
    'the','and','for','with','that','this','from','have','were','which','their','also','are','was','but','not','you','your','can','all','any','one','use','using','used','will','should','may','such','into','more','other','than','then','when','what','where','who','how','its','it','is','of','on','in','to','a','an'
  ]);

  const sentences = text
    .replace(/\r\n/g, ' ')
    .replace(/\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 20);

  if (sentences.length <= 3) {
    return sentences.join(' ');
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopwords.has(word));

  const freq = {};
  for (const word of words) {
    freq[word] = (freq[word] || 0) + 1;
  }

  const keywordWeights = {
    'install': 3,
    'setup': 3,
    'configure': 4,
    'configuration': 4,
    'require': 2,
    'requirement': 2,
    'step': 4,
    'steps': 4,
    'example': 2,
    'use': 2,
    'using': 2,
    'function': 3,
    'class': 3,
    'method': 3,
    'api': 4,
    'command': 4,
    'npm': 5,
    'node': 4,
    'express': 4,
    'upload': 3,
    'pdf': 3
  };

  const sentenceScores = sentences.map(sentence => {
    const normalized = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const sentenceWords = normalized.split(/\s+/).filter(word => word.length > 2);
    let score = 0;

    for (const word of sentenceWords) {
      if (freq[word]) {
        score += freq[word];
      }
      if (keywordWeights[word]) {
        score += keywordWeights[word] * 2;
      }
    }

    return { sentence, score };
  });

  const topSentences = sentenceScores
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(5, sentenceScores.length))
    .sort((a, b) => sentences.indexOf(a.sentence) - sentences.indexOf(b.sentence))
    .map(item => item.sentence);

  return topSentences.join(' ');
}

const PORT = parseInt(process.env.PORT || '3001', 10);

function startServer(port) {
  const server = app.listen(port, () => {
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

startServer(PORT);
