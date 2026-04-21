# PDF Programming Summarizer

A Node.js API server that uploads PDF files, extracts page-range text, and generates implementation-focused summaries.

This repository also includes a local LLM subproject for extractor/planner/embedding workflows.

## What This Project Does

- Accepts PDF uploads through a REST API
- Extracts text by page range using pdfjs-dist
- Produces programming-focused summaries
- Supports optional local AI pipelines (extractor and planner)
- Supports optional embedding generation and artifact storage

## Project Structure

- `server.js`: Main API server
- `subprojects/local-llm/`: Local LLM and embedding scripts
- `storage/`: Local runtime storage (if not overridden)
- `uploads/`: Uploaded file temp area

## Quick Start

### 1) Install dependencies

```bash
npm install
```

### 2) Run API server

```bash
npm start
```

Default server URL:

- http://127.0.0.1:3001

## API

### Health check

```bash
curl -s http://127.0.0.1:3001/health
```

### Upload PDF and summarize

```bash
curl -X POST -F "pdf=@/path/to/file.pdf" "http://127.0.0.1:3001/upload?startPage=1&endPage=10&useAI=true&generateEmbeddings=false&aiTimeoutSec=180"
```

## Optional Local LLM Subproject

Local orchestration scripts are in:

- `subprojects/local-llm/start-all.ps1`
- `subprojects/local-llm/stop-all.ps1`
- `subprojects/local-llm/set-local-llm-env.ps1`

Typical usage on Windows PowerShell:

```powershell
.\subprojects\local-llm\start-all.ps1
```

## Notes

- Large model files are recommended on SSD storage.
- Environment variables can override storage paths, model paths, and endpoint URLs.
- Test PDFs are ignored from git tracking.

## For Internal Handoff

If you need the detailed internal operating guide and troubleshooting notes, see:

- `README.md`
