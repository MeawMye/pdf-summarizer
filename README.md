# PDF Text Extractor and Summarizer

A simple Node.js Express web server that allows PDF file uploads, extracts text using the pdf-parse library, summarizes the content, and returns the summary via REST API.

The purpose is to summarize programming-related sequences or information from large PDF documents.

## Installation

1. Install dependencies: `npm install`

## Usage

1. Start the server: `npm start`
2. The server runs on `http://localhost:3001`
3. Use a tool like Postman or curl to send a POST request to `/upload` with a PDF file in the 'pdf' field (multipart/form-data).

## API Endpoints

### POST /upload
Upload a PDF file and get a text summary.

**Parameters (Optional):**
- `startPage` (query): Starting page number (1-indexed)
- `endPage` (query): Ending page number (1-indexed)

**Examples:**

#### Upload entire PDF:
```powershell
curl.exe -X POST -F "pdf=@C:\path\to\file.pdf" http://localhost:3001/upload
```

#### Upload specific page range (pages 1-5):
```powershell
curl.exe -X POST -F "pdf=@C:\path\to\file.pdf" "http://localhost:3001/upload?startPage=1&endPage=5"
```

#### Upload from specific page onwards (page 10 to end):
```powershell
curl.exe -X POST -F "pdf=@C:\path\to\file.pdf" "http://localhost:3001/upload?startPage=10"
```

### Response Format
```json
{
  "summary": "Summarized text...",
  "totalPages": 80,
  "requestedPages": "1-5",
  "fileName": "file.pdf",
  "note": "Currently processes full PDF text..."
}
```

## Using Postman
1. Postman 실행
2. 새 요청 생성
3. 메서드: `POST`
4. URL: `http://localhost:3001/upload?startPage=1&endPage=5` (페이지 지정 시)
5. Body 탭 선택
6. `form-data` 선택
7. 키 이름: `pdf`
8. 타입: `File`
9. 업로드할 PDF 파일 선택
10. Send 클릭

## Dependencies

- express: Web framework
- multer: File upload handling
- pdf-parse: PDF text extraction

## Current Limitations

- Summarization is basic (first 500 words)
- Page range parameter validation only (actual page-by-page extraction requires additional library)

## Future Improvements

1. Advanced summarization using AI services (OpenAI, etc.)
2. Precise page-by-page text extraction using pdfjs-dist
3. Programming-focused summary extraction
4. Support for multiple PDF upload formats