'use strict';

// Curated public GitHub resources the GitHub research agent checks first when the
// question matches their topics. The agent decides relevance and still searches widely.
// To add one: give a public URL, Korean topics, what it is, and how to apply it.
const GITHUB_RESOURCES = Object.freeze([
  {
    id: 'gstack', url: 'https://github.com/garrytan/gstack', title: 'gstack (Garry Tan)',
    topics: ['신사업', '창업', '제품 아이디어', '사업 전략', '스타트업', 'MVP'],
    summary: 'Y Combinator 대표 Garry Tan이 공개한 Claude Code 스킬 모음(MIT). /office-hours는 아이디어의 전제를 반박하고 대안을 만들며, /plan-ceo-review는 확장·선택적 확장·범위 유지·축소 네 가지 관점으로 사업 범위를 다시 본다.',
    apply: '신사업·제품 아이디어를 판단할 때 office-hours식 전제 반박 질문과 CEO 리뷰의 네 가지 범위 관점을 분석 틀로 적용한다.',
  },
  {
    id: 'llm-wiki', url: 'https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f', title: 'LLM Wiki (Andrej Karpathy)',
    topics: ['지식 관리', '지식 저장', '사내 위키', '문서화', 'RAG', '개인 지식 베이스'],
    summary: 'LLM이 원본 자료를 읽어 서로 연결된 마크다운 위키를 계속 갱신하는 지식 관리 패턴. 원본·위키·스키마 세 층과 index.md·log.md, 수집(ingest)·질의(query)·점검(lint) 작업으로 구성된다.',
    apply: '지식 저장·관리 방식을 판단할 때 RAG 대비 누적형 위키의 장단점, 운영 비용, 점검 절차를 비교 기준으로 쓴다.',
  },
]);

module.exports = { GITHUB_RESOURCES };
