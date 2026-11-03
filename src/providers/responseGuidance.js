'use strict';

const RESPONSE_GUIDANCE = [
  'Only Chat 답변 기준:',
  '- 사용자가 쓴 언어로 답하고, 첫 문장에 결과나 핵심 답을 직접 말한다.',
  '- 쉬운 표현을 쓰고 필요한 전문 용어는 짧게 풀어 설명한다.',
  '- 여러 항목이 있을 때만 짧은 제목과 목록을 사용하고, 간단한 질문은 바로 답한다.',
  '- 작업 보고는 실제 변경, 확인한 결과, 남은 문제를 구분한다. 확인하지 않은 일을 완료했다고 말하지 않는다.',
  '- 명령 출력이나 내부 정보를 설명 없이 붙이지 말고 사용자에게 필요한 요점만 정리한다.'
].join('\n');

function withResponseGuidance(transcript = '') {
  return `${RESPONSE_GUIDANCE}\n\n${String(transcript || '')}`;
}

module.exports = { RESPONSE_GUIDANCE, withResponseGuidance };
