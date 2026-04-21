# PDF Programming Summarizer (Agent Handoff Edition)

이 저장소의 목적은 다음 두 가지입니다.

1. PDF에서 기술 텍스트를 추출하고, 실제 구현 순서 중심으로 요약한다.
2. 다른 로컬 환경(다른 PC)으로 이동해도 README만 보고 AI 에이전트가 이어서 작업할 수 있게 한다.

아래 내용은 운영 문서이자 인수인계 문서입니다.

---

## 1) 왜 이 구조를 선택했는가

### SSD를 기준으로 설계한 이유 (완전 자체 포함)

- 모델 파일(GGUF/임베딩 모델)은 크기가 크고 다운로드 시간이 길다.
- llama.cpp 런타임(llama-server.exe)도 SSD에 포함되어 있다.
- 모델, 런타임, 산출물(임베딩 JSON)을 모두 SSD에 고정하면, PC를 바꿔도 SSD만 연결하면 추가 설치 없이 즉시 작업을 재개할 수 있다.
- **C 드라이브와의 의존성이 완전히 제거되었다.**
- 경로를 환경변수로 분리했기 때문에 코드 수정 없이 재배치가 가능하다.

### 2단계 모델(추출기/순서화기)을 분리한 이유

- 1단계 추출기: 문서에서 구현에 필요한 신호만 압축
- 2단계 순서화기: 추출된 신호를 실행 가능한 작업 순서로 재구성
- 단일 모델 1회 호출보다 결과 형식 제어와 후속 자동화 안정성이 좋아진다.

### 현재 모델 선택 이유

- Extractor: Qwen2.5-3B Instruct Q4_K_M
  - 비교적 가벼워서 빠른 필터링/추출에 유리
- Planner: Qwen2.5-7B Instruct Q4_K_M
  - 단계화/구조화 응답 품질이 더 안정적
- Embedding(현재 실행 경로): sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
  - fastembed에서 즉시 구동 가능, 다국어 처리 가능, 초기 세팅 속도가 빠름

참고:

- BAAI/bge-m3 파일은 SSD에 다운로드되어 있으나, 현재 fastembed TextEmbedding 경로로는 직접 로딩되지 않는다.
- bge-m3를 엄밀히 유지하려면 별도 bge-m3 전용 서빙 스택(Transformers/TEI/vLLM 계열)으로 5003만 교체하면 된다.

---

## 2) 현재 아키텍처 요약

1. Node API 서버가 PDF를 업로드 받는다.
2. pdfjs-dist로 페이지 범위 텍스트를 추출한다.
3. Extractor API(5001)에 호출해 핵심 지식을 추출한다.
4. Planner API(5002)에 호출해 실행 순서를 생성한다.
5. 선택 시 Embedding API(5003)에 호출해 임베딩을 만들고 SSD에 저장한다.

핵심 파일:

- server.js
- subprojects/local-llm/set-local-llm-env.ps1
- subprojects/local-llm/download-local-models.ps1
- subprojects/local-llm/embedding_api.py
- subprojects/local-llm/start-embedding-server.ps1

---

## 3) SSD 권장 디렉터리

현재 기준 경로:

```text
D:\local-llm\
  bin\
    llama-server.exe         (llama.cpp 런타임)
  models\
    extractor\qwen2.5-3b-instruct\
    planner\qwen2.5-7b-instruct\
    embedding\bge-m3\
  data\
    uploads\
    embeddings\
```

필수 확인 포인트:

- planner GGUF는 분할 파일에서 단일 파일로 병합되어 있어야 한다.
- llama-server.exe는 SSD 루트의 bin/ 디렉터리에 위치해야 한다.
- 임베딩 산출물은 D:\local-llm\data\embeddings 아래 JSON으로 누적된다.

---

## 4) 환경변수 (운영 기준)

subprojects/local-llm/set-local-llm-env.ps1 기준:

```powershell
$env:STORAGE_ROOT = 'D:\local-llm\data'
$env:LOCAL_MODEL_ROOT = 'D:\local-llm\models'

$env:EXTRACTOR_LLM_API_URL = 'http://127.0.0.1:5001/v1/chat/completions'
$env:PLANNER_LLM_API_URL = 'http://127.0.0.1:5002/v1/chat/completions'
$env:EMBEDDING_API_URL = 'http://127.0.0.1:5003/v1/embeddings'

$env:EXTRACTOR_LLM_MODEL = 'qwen2.5-3b-instruct-q4_k_m'
$env:PLANNER_LLM_MODEL = 'qwen2.5-7b-instruct-q4_k_m'
$env:EMBEDDING_MODEL = 'bge-m3'

$env:AI_TIMEOUT_MS = '180000'
```

주의:

- Node 쪽 EMBEDDING_MODEL 문자열은 메타데이터 용도이므로 bge-m3로 유지해도 동작한다.
- 실제 임베딩 서버 모델은 subprojects/local-llm/start-embedding-server.ps1 또는 실행 시점 환경변수 값이 우선한다.

---

## 5) 서버 기동 순서 (새 PC에서도 동일)

### 5-1. 의존성

```powershell
npm install
python -m pip install --upgrade pip fastapi uvicorn fastembed
```

### 5-2. 전체 서버 일괄 실행(권장)

```powershell
.\subprojects\local-llm\start-all.ps1
```

이 스크립트가 아래 4개를 한 번에 올립니다.

- extractor(5001)
- planner(5002)
- embedding(5003)
- node-api(3001)

프로세스 기록 파일:

- subprojects/local-llm/.runtime/processes.json

참고:

- EMBEDDING_MODEL이 bge-m3이거나 비어 있으면 start-all은 실행 가능성을 위해
  sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2로 자동 보정한다.
- llama-server.exe는 D:\local-llm\bin에서 자동으로 로드된다. (SSD 기반 자체 포함)

### 5-3. 전체 서버 일괄 중지

```powershell
.\subprojects\local-llm\stop-all.ps1
```

### 5-4. 수동 실행이 필요할 때

수동 방식은 디버깅 용도로만 권장하며, 기본 운영은 start-all/stop-all을 사용한다.

---

## 6) API

### GET /health

```powershell
curl.exe -s http://127.0.0.1:3001/health
```

### POST /upload

쿼리:

- startPage
- endPage
- useAI=true
- generateEmbeddings=true
- aiTimeoutSec=180

예시:

```powershell
curl.exe -X POST -F "pdf=@C:\path\to\file.pdf" "http://127.0.0.1:3001/upload?startPage=1&endPage=10&useAI=true&generateEmbeddings=true&aiTimeoutSec=180"
```

응답 핵심 필드:

- summary
- extractedKnowledge
- summaryMode
- embeddingInfo.status
- embeddingInfo.artifactPath

---

## 7) 현재까지 검증 완료된 상태

2026-04-21 기준 확인:

- 7B planner split GGUF 병합 완료
- extractor(5001), planner(5002) 서버 기동 및 추론 응답 확인
- embedding(5003) 서버 기동 및 /v1/embeddings 응답 확인
- /upload useAI=true + generateEmbeddings=true end-to-end 성공
- 임베딩 산출물 생성 확인:
  - D:\local-llm\data\embeddings\1776736596797-pdf_test___-embeddings.json

---

## 8) 에이전트 재진입 체크리스트 (핵심)

다른 환경에서 AI 에이전트가 작업을 바로 이어가려면 아래 순서만 확인하면 된다.
**C 드라이브에는 아무것도 필요 없고, SSD(D:\local-llm) 하나만으로 완전 독립적이다.**

1. SSD 경로에 모델/데이터/런타임 폴더 존재 여부 확인
   - D:\local-llm\bin\llama-server.exe
   - D:\local-llm\models\extractor\...
   - D:\local-llm\models\planner\...
   - D:\local-llm\data\uploads\
   - D:\local-llm\data\embeddings\
2. 5001/5002/5003 프로세스 상태 확인 (또는 start-all.ps1 실행)
3. /health에서 API URL/저장경로 반영 확인
4. 샘플 PDF로 /upload 스모크 테스트
5. D:\local-llm\data\embeddings에 새 JSON 생성 확인

스모크 테스트 실패 시 우선순위:

1. 포트 충돌 여부 확인
2. 모델 파일 경로/파일명 오탈자 확인
3. 임베딩 서버 모델 호환성 확인(fastembed 지원 모델인지)

---

## 9) 알려진 이슈와 운영 메모

**2026-04-21 업데이트: C 드라이브 의존성 완전 제거**

- llama-server.exe가 이제 D:\local-llm\bin에 포함되어 있다.
- text-generation-webui 또는 다른 C 드라이브 설치 도구는 더 이상 필요 없다.
- SSD만으로 완전 독립적인 실행 환경이 구성되었다.

**기타 운영 메모:**

- Windows PowerShell에서 Invoke-RestMethod -Form 파라미터가 버전에 따라 없을 수 있다.
  - 업로드 테스트는 curl.exe -F 사용 권장
- fastembed 캐시는 기본적으로 시스템 임시 경로를 사용한다.
  - 필요 시 별도 캐시 경로 정책을 정해 SSD로 이동 가능
- Node 서버는 포트 충돌 시 자동으로 다음 포트로 이동한다.

---

## 10) 다음 개선 후보

1. 임베딩 저장 포맷을 JSON + SQLite 병행으로 확장
2. /search API 추가(RAG 전처리 데이터 재사용)
3. bge-m3 전용 서빙 모드 추가(현재 fastembed 대체 경로 보완)