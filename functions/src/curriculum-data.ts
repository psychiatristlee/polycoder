export interface CurriculumSeedEntry {
  grade: number;
  semester: number;
  unitNumber: number;
  unitTitle: string;
  domain: string;
  learningObjectives: string[];
  keyConcepts: string[];
  exampleProblemTypes: string[];
}

export const CURRICULUM_2022: CurriculumSeedEntry[] = [
  // ═══════════════════════════════════════
  // 1학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 1, semester: 1, unitNumber: 1,
    unitTitle: "9까지의 수",
    domain: "수와 연산",
    learningObjectives: [
      "1부터 9까지의 수를 세고, 읽고, 쓸 수 있다",
      "수의 순서를 알고 수의 크기를 비교할 수 있다",
      "1 큰 수와 1 작은 수를 알 수 있다",
      "수를 이용하여 순서를 나타낼 수 있다",
    ],
    keyConcepts: ["자연수", "수 세기", "수의 순서", "크기 비교", "하나 더 많다", "하나 더 적다"],
    exampleProblemTypes: [
      "그림을 보고 수 세기",
      "수의 크기 비교 (부등호)",
      "순서에 맞게 수 배열하기",
      "빈칸에 알맞은 수 넣기",
    ],
  },
  {
    grade: 1, semester: 1, unitNumber: 2,
    unitTitle: "여러 가지 모양",
    domain: "도형과 측정",
    learningObjectives: [
      "네모, 세모, 동그라미 모양을 구별할 수 있다",
      "여러 가지 물건에서 모양을 찾을 수 있다",
      "같은 모양끼리 모을 수 있다",
    ],
    keyConcepts: ["네모", "세모", "동그라미", "모양 분류", "입체도형의 모양"],
    exampleProblemTypes: [
      "물건의 모양 구별하기",
      "같은 모양끼리 분류하기",
      "모양의 특징 설명하기",
      "주변에서 모양 찾기",
    ],
  },
  {
    grade: 1, semester: 1, unitNumber: 3,
    unitTitle: "덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "9 이하의 수에서 모으기와 가르기를 할 수 있다",
      "한 자리 수의 덧셈을 할 수 있다",
      "한 자리 수의 뺄셈을 할 수 있다",
      "덧셈식과 뺄셈식으로 나타낼 수 있다",
    ],
    keyConcepts: ["모으기", "가르기", "더하기", "빼기", "덧셈식", "뺄셈식", "합", "차"],
    exampleProblemTypes: [
      "그림을 보고 덧셈식 만들기",
      "한 자리 수 덧셈 계산",
      "한 자리 수 뺄셈 계산",
      "빈칸에 알맞은 수 넣기",
    ],
  },
  {
    grade: 1, semester: 1, unitNumber: 4,
    unitTitle: "비교하기",
    domain: "도형과 측정",
    learningObjectives: [
      "두 양의 길이, 높이, 넓이를 비교할 수 있다",
      "두 양의 무게, 들이를 비교할 수 있다",
      "비교하는 말을 사용하여 표현할 수 있다",
    ],
    keyConcepts: ["길다/짧다", "높다/낮다", "넓다/좁다", "무겁다/가볍다", "많다/적다"],
    exampleProblemTypes: [
      "그림을 보고 길이 비교하기",
      "무게 비교하기",
      "넓이 비교하기",
      "비교하는 말로 표현하기",
    ],
  },
  {
    grade: 1, semester: 1, unitNumber: 5,
    unitTitle: "50까지의 수",
    domain: "수와 연산",
    learningObjectives: [
      "10개씩 묶어 세고 십 몇, 몇십을 알 수 있다",
      "50까지의 수를 세고, 읽고, 쓸 수 있다",
      "50까지의 수의 순서를 알고 크기를 비교할 수 있다",
    ],
    keyConcepts: ["십 몇", "몇십", "10개씩 묶기", "수의 순서", "크기 비교"],
    exampleProblemTypes: [
      "10개씩 묶어 세기",
      "수를 읽고 쓰기",
      "수의 크기 비교하기",
      "수 배열에서 빈칸 채우기",
    ],
  },

  // ═══════════════════════════════════════
  // 1학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 1, semester: 2, unitNumber: 1,
    unitTitle: "100까지의 수",
    domain: "수와 연산",
    learningObjectives: [
      "60, 70, 80, 90, 100을 알 수 있다",
      "99까지의 수를 세고, 읽고, 쓸 수 있다",
      "100까지의 수의 순서를 알고 크기를 비교할 수 있다",
    ],
    keyConcepts: ["몇십", "99까지의 수", "100", "십의 자리", "일의 자리", "수의 크기 비교"],
    exampleProblemTypes: [
      "두 자리 수 읽고 쓰기",
      "수의 크기 비교하기",
      "수 배열표에서 규칙 찾기",
      "1 큰 수, 1 작은 수 구하기",
    ],
  },
  {
    grade: 1, semester: 2, unitNumber: 2,
    unitTitle: "덧셈과 뺄셈 (1)",
    domain: "수와 연산",
    learningObjectives: [
      "받아올림이 없는 두 자리 수와 한 자리 수의 덧셈을 할 수 있다",
      "받아내림이 없는 두 자리 수와 한 자리 수의 뺄셈을 할 수 있다",
      "10을 만드는 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["10 만들기", "두 자리 수", "덧셈", "뺄셈", "받아올림 없는"],
    exampleProblemTypes: [
      "두 자리 수 + 한 자리 수 계산",
      "두 자리 수 - 한 자리 수 계산",
      "10을 만드는 더하기",
      "덧셈/뺄셈 문장제",
    ],
  },
  {
    grade: 1, semester: 2, unitNumber: 3,
    unitTitle: "여러 가지 모양",
    domain: "도형과 측정",
    learningObjectives: [
      "평면도형의 모양인 네모, 세모, 동그라미를 알 수 있다",
      "여러 가지 모양으로 그림을 그리거나 꾸밀 수 있다",
      "모양의 특징을 알 수 있다",
    ],
    keyConcepts: ["평면도형", "네모", "세모", "동그라미", "모양 꾸미기", "모양의 특징"],
    exampleProblemTypes: [
      "평면 모양 구별하기",
      "모양의 개수 세기",
      "모양으로 무늬 만들기",
      "모양의 특징 비교하기",
    ],
  },
  {
    grade: 1, semester: 2, unitNumber: 4,
    unitTitle: "덧셈과 뺄셈 (2)",
    domain: "수와 연산",
    learningObjectives: [
      "받아올림이 있는 한 자리 수끼리의 덧셈을 할 수 있다",
      "받아내림이 있는 (십 몇) - (한 자리 수) 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["받아올림", "받아내림", "10 넘기기", "십 몇에서 빼기"],
    exampleProblemTypes: [
      "받아올림 있는 덧셈 계산",
      "받아내림 있는 뺄셈 계산",
      "10 넘기기 전략 사용하기",
      "덧셈/뺄셈 혼합 문제",
    ],
  },
  {
    grade: 1, semester: 2, unitNumber: 5,
    unitTitle: "시계 보기와 규칙 찾기",
    domain: "도형과 측정",
    learningObjectives: [
      "시계를 보고 몇 시, 몇 시 30분을 읽을 수 있다",
      "규칙을 찾아 다음에 올 것을 예상할 수 있다",
    ],
    keyConcepts: ["시계", "몇 시", "몇 시 30분", "긴바늘", "짧은바늘", "규칙", "반복"],
    exampleProblemTypes: [
      "시계를 보고 시각 읽기",
      "주어진 시각에 맞게 시계 바늘 그리기",
      "반복되는 규칙 찾기",
      "규칙에 맞게 다음 것 예상하기",
    ],
  },
  {
    grade: 1, semester: 2, unitNumber: 6,
    unitTitle: "덧셈과 뺄셈 (3)",
    domain: "수와 연산",
    learningObjectives: [
      "받아올림/받아내림이 없는 두 자리 수끼리의 덧셈과 뺄셈을 할 수 있다",
      "세 수의 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["두 자리 수 덧셈", "두 자리 수 뺄셈", "세 수의 계산"],
    exampleProblemTypes: [
      "두 자리 수 + 두 자리 수 (받아올림 없는)",
      "두 자리 수 - 두 자리 수 (받아내림 없는)",
      "세 수의 덧셈/뺄셈",
      "실생활 문장제",
    ],
  },

  // ═══════════════════════════════════════
  // 2학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 2, semester: 1, unitNumber: 1,
    unitTitle: "세 자리 수",
    domain: "수와 연산",
    learningObjectives: [
      "백, 몇백을 알 수 있다",
      "세 자리 수를 읽고, 쓰고, 세 수 있다",
      "각 자리의 숫자가 나타내는 값을 알 수 있다",
      "세 자리 수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["백", "백의 자리", "십의 자리", "일의 자리", "자릿값", "크기 비교"],
    exampleProblemTypes: [
      "세 자리 수 읽고 쓰기",
      "자릿값 구하기",
      "세 자리 수 크기 비교",
      "뛰어 세기",
    ],
  },
  {
    grade: 2, semester: 1, unitNumber: 2,
    unitTitle: "여러 가지 도형",
    domain: "도형과 측정",
    learningObjectives: [
      "삼각형, 사각형, 원을 알고 구별할 수 있다",
      "오각형, 육각형을 알 수 있다",
      "도형의 꼭짓점, 변, 면을 알 수 있다",
    ],
    keyConcepts: ["삼각형", "사각형", "원", "오각형", "육각형", "꼭짓점", "변"],
    exampleProblemTypes: [
      "도형의 이름 맞추기",
      "꼭짓점과 변의 수 세기",
      "도형 분류하기",
      "점을 이어 도형 만들기",
    ],
  },
  {
    grade: 2, semester: 1, unitNumber: 3,
    unitTitle: "덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "받아올림이 있는 두 자리 수의 덧셈을 할 수 있다",
      "받아내림이 있는 두 자리 수의 뺄셈을 할 수 있다",
      "세 자리 수의 덧셈과 뺄셈의 기초를 알 수 있다",
    ],
    keyConcepts: ["받아올림", "받아내림", "세로셈", "가로셈"],
    exampleProblemTypes: [
      "두 자리 수 + 두 자리 수 (받아올림)",
      "두 자리 수 - 두 자리 수 (받아내림)",
      "덧셈과 뺄셈의 관계",
      "실생활 덧셈/뺄셈 문장제",
    ],
  },
  {
    grade: 2, semester: 1, unitNumber: 4,
    unitTitle: "길이 재기",
    domain: "도형과 측정",
    learningObjectives: [
      "1cm를 알고 길이를 잴 수 있다",
      "자를 이용하여 길이를 재고 어림할 수 있다",
      "길이를 단위를 사용하여 나타낼 수 있다",
    ],
    keyConcepts: ["센티미터(cm)", "자", "길이 재기", "길이 어림", "단위길이"],
    exampleProblemTypes: [
      "자를 이용해 길이 재기",
      "길이 어림하기",
      "cm 단위로 나타내기",
      "길이의 합과 차 구하기",
    ],
  },
  {
    grade: 2, semester: 1, unitNumber: 5,
    unitTitle: "분류하기",
    domain: "자료와 가능성",
    learningObjectives: [
      "기준에 따라 분류할 수 있다",
      "분류한 결과를 세어 보고 말할 수 있다",
      "기준을 정하여 분류할 수 있다",
    ],
    keyConcepts: ["분류", "기준", "같은 점", "다른 점", "세기"],
    exampleProblemTypes: [
      "기준에 따라 분류하기",
      "분류 결과 세기",
      "분류 기준 정하기",
      "분류 결과 비교하기",
    ],
  },
  {
    grade: 2, semester: 1, unitNumber: 6,
    unitTitle: "곱셈",
    domain: "수와 연산",
    learningObjectives: [
      "묶어 세기를 통해 곱셈을 이해할 수 있다",
      "곱셈식으로 나타내고 읽을 수 있다",
      "2, 5의 단 곱셈구구를 알 수 있다",
    ],
    keyConcepts: ["묶어 세기", "몇씩 몇 묶음", "곱셈식", "곱셈구구", "2의 단", "5의 단"],
    exampleProblemTypes: [
      "묶어 세기로 곱셈 이해하기",
      "곱셈식으로 나타내기",
      "2의 단, 5의 단 곱셈구구",
      "곱셈 문장제",
    ],
  },

  // ═══════════════════════════════════════
  // 2학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 2, semester: 2, unitNumber: 1,
    unitTitle: "네 자리 수",
    domain: "수와 연산",
    learningObjectives: [
      "천, 몇천을 알 수 있다",
      "네 자리 수를 읽고, 쓰고, 셀 수 있다",
      "네 자리 수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["천", "천의 자리", "자릿값", "네 자리 수", "크기 비교"],
    exampleProblemTypes: [
      "네 자리 수 읽고 쓰기",
      "자릿값 구하기",
      "네 자리 수 크기 비교",
      "뛰어 세기",
    ],
  },
  {
    grade: 2, semester: 2, unitNumber: 2,
    unitTitle: "곱셈구구",
    domain: "수와 연산",
    learningObjectives: [
      "2~9의 단 곱셈구구를 외울 수 있다",
      "곱셈구구표를 만들고 활용할 수 있다",
      "곱셈구구에서 규칙을 찾을 수 있다",
    ],
    keyConcepts: ["곱셈구구", "2의 단~9의 단", "곱셈구구표", "곱셈의 교환법칙"],
    exampleProblemTypes: [
      "곱셈구구 계산하기",
      "곱셈구구표에서 빈칸 채우기",
      "곱셈구구의 규칙 찾기",
      "곱셈 문장제",
    ],
  },
  {
    grade: 2, semester: 2, unitNumber: 3,
    unitTitle: "길이 재기",
    domain: "도형과 측정",
    learningObjectives: [
      "1m를 알고 1m = 100cm의 관계를 이해할 수 있다",
      "길이를 m와 cm 단위로 나타낼 수 있다",
      "길이를 어림하고 잴 수 있다",
    ],
    keyConcepts: ["미터(m)", "센티미터(cm)", "1m = 100cm", "길이 어림", "길이 재기"],
    exampleProblemTypes: [
      "m와 cm 단위 변환",
      "길이 어림하기",
      "길이의 합과 차 구하기",
      "실생활 길이 문제",
    ],
  },
  {
    grade: 2, semester: 2, unitNumber: 4,
    unitTitle: "시각과 시간",
    domain: "도형과 측정",
    learningObjectives: [
      "몇 시 몇 분을 읽을 수 있다",
      "1시간 = 60분을 알 수 있다",
      "하루의 시간을 이해할 수 있다",
    ],
    keyConcepts: ["시각", "시간", "몇 시 몇 분", "1시간 = 60분", "오전/오후", "하루 = 24시간"],
    exampleProblemTypes: [
      "시계를 보고 시각 읽기",
      "시간의 합과 차 구하기",
      "시간 단위 변환",
      "시각과 시간 문장제",
    ],
  },
  {
    grade: 2, semester: 2, unitNumber: 5,
    unitTitle: "표와 그래프",
    domain: "자료와 가능성",
    learningObjectives: [
      "자료를 조사하여 표로 나타낼 수 있다",
      "자료를 ○, /, 등으로 그래프로 나타낼 수 있다",
      "표와 그래프를 보고 내용을 파악할 수 있다",
    ],
    keyConcepts: ["자료 조사", "표", "그래프", "○ 그래프", "/ 그래프"],
    exampleProblemTypes: [
      "자료를 표로 정리하기",
      "표를 보고 그래프 그리기",
      "그래프를 보고 자료 해석하기",
      "가장 많은/적은 것 찾기",
    ],
  },
  {
    grade: 2, semester: 2, unitNumber: 6,
    unitTitle: "규칙 찾기",
    domain: "변화와 관계",
    learningObjectives: [
      "물체, 무늬, 수의 배열에서 규칙을 찾을 수 있다",
      "규칙에 따라 다음에 올 것을 예상할 수 있다",
      "자신만의 규칙을 만들어 배열할 수 있다",
    ],
    keyConcepts: ["규칙", "반복", "수 배열", "무늬 배열", "규칙 만들기"],
    exampleProblemTypes: [
      "반복되는 규칙 찾기",
      "수 배열의 규칙 찾기",
      "규칙에 맞게 빈칸 채우기",
      "규칙을 만들어 배열하기",
    ],
  },

  // ═══════════════════════════════════════
  // 3학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 3, semester: 1, unitNumber: 1,
    unitTitle: "덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "세 자리 수의 덧셈을 할 수 있다",
      "세 자리 수의 뺄셈을 할 수 있다",
      "덧셈과 뺄셈의 관계를 이해할 수 있다",
    ],
    keyConcepts: ["세 자리 수", "받아올림", "받아내림", "덧셈과 뺄셈의 관계", "검산"],
    exampleProblemTypes: [
      "세 자리 수 + 세 자리 수",
      "세 자리 수 - 세 자리 수",
      "연속 받아올림/받아내림",
      "덧셈/뺄셈 문장제",
    ],
  },
  {
    grade: 3, semester: 1, unitNumber: 2,
    unitTitle: "평면도형",
    domain: "도형과 측정",
    learningObjectives: [
      "선분, 반직선, 직선을 알 수 있다",
      "각과 직각을 알 수 있다",
      "직각삼각형, 직사각형, 정사각형을 알 수 있다",
    ],
    keyConcepts: ["선분", "반직선", "직선", "각", "직각", "직각삼각형", "직사각형", "정사각형"],
    exampleProblemTypes: [
      "선분/반직선/직선 구별하기",
      "직각 찾기",
      "직각삼각형/직사각형/정사각형 구별하기",
      "도형의 변과 꼭짓점 수 구하기",
    ],
  },
  {
    grade: 3, semester: 1, unitNumber: 3,
    unitTitle: "나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "나눗셈의 의미를 알고 나눗셈식으로 나타낼 수 있다",
      "곱셈과 나눗셈의 관계를 이해할 수 있다",
      "곱셈구구를 이용하여 나눗셈을 할 수 있다",
    ],
    keyConcepts: ["나눗셈", "÷", "몫", "나누기", "똑같이 나누기", "곱셈과 나눗셈의 관계"],
    exampleProblemTypes: [
      "똑같이 나누기",
      "나눗셈식으로 나타내기",
      "곱셈구구를 이용한 나눗셈",
      "나눗셈 문장제",
    ],
  },
  {
    grade: 3, semester: 1, unitNumber: 4,
    unitTitle: "곱셈",
    domain: "수와 연산",
    learningObjectives: [
      "(두 자리 수) × (한 자리 수)를 할 수 있다",
      "(세 자리 수) × (한 자리 수)를 할 수 있다",
      "곱셈의 결과를 어림할 수 있다",
    ],
    keyConcepts: ["두 자리 수의 곱셈", "세 자리 수의 곱셈", "곱셈 어림", "올림이 있는 곱셈"],
    exampleProblemTypes: [
      "(두 자리 수) × (한 자리 수) 계산",
      "(세 자리 수) × (한 자리 수) 계산",
      "곱셈 결과 어림하기",
      "곱셈 문장제",
    ],
  },
  {
    grade: 3, semester: 1, unitNumber: 5,
    unitTitle: "길이와 시간",
    domain: "도형과 측정",
    learningObjectives: [
      "1mm, 1km를 알고 단위 사이의 관계를 이해할 수 있다",
      "길이를 어림하고 잴 수 있다",
      "초를 알고 시간의 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: [
      "밀리미터(mm)", "킬로미터(km)",
      "1cm = 10mm", "1km = 1000m", "초", "1분 = 60초",
    ],
    exampleProblemTypes: [
      "길이 단위 변환",
      "길이 어림하기",
      "시간의 덧셈과 뺄셈",
      "시간 단위 변환",
    ],
  },
  {
    grade: 3, semester: 1, unitNumber: 6,
    unitTitle: "분수와 소수",
    domain: "수와 연산",
    learningObjectives: [
      "분수를 알고 읽고 쓸 수 있다",
      "단위분수의 크기를 비교할 수 있다",
      "소수를 알고 읽고 쓸 수 있다",
      "소수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["분수", "분모", "분자", "단위분수", "소수", "소수점", "0.1"],
    exampleProblemTypes: [
      "그림을 보고 분수로 나타내기",
      "단위분수 크기 비교",
      "소수 읽고 쓰기",
      "소수 크기 비교",
    ],
  },

  // ═══════════════════════════════════════
  // 3학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 3, semester: 2, unitNumber: 1,
    unitTitle: "곱셈",
    domain: "수와 연산",
    learningObjectives: [
      "(두 자리 수) × (두 자리 수)를 할 수 있다",
      "곱셈의 다양한 방법을 이해할 수 있다",
      "곱셈의 결과를 어림할 수 있다",
    ],
    keyConcepts: ["두 자리 수끼리의 곱셈", "부분곱", "곱셈 어림"],
    exampleProblemTypes: [
      "(두 자리 수) × (두 자리 수) 계산",
      "곱셈 세로셈",
      "곱셈 결과 어림하기",
      "곱셈 문장제",
    ],
  },
  {
    grade: 3, semester: 2, unitNumber: 2,
    unitTitle: "나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(두 자리 수) ÷ (한 자리 수)를 할 수 있다",
      "나머지가 있는 나눗셈을 할 수 있다",
      "나눗셈의 검산을 할 수 있다",
    ],
    keyConcepts: ["나머지", "나머지가 있는 나눗셈", "나눗셈 검산", "몫과 나머지"],
    exampleProblemTypes: [
      "(두 자리 수) ÷ (한 자리 수) 계산",
      "나머지 구하기",
      "나눗셈 검산하기",
      "나눗셈 문장제 (나머지 해석)",
    ],
  },
  {
    grade: 3, semester: 2, unitNumber: 3,
    unitTitle: "원",
    domain: "도형과 측정",
    learningObjectives: [
      "원의 중심, 반지름, 지름을 알 수 있다",
      "원의 성질을 이해할 수 있다",
      "컴퍼스를 이용하여 원을 그릴 수 있다",
    ],
    keyConcepts: ["원", "중심", "반지름", "지름", "지름 = 반지름 × 2", "컴퍼스"],
    exampleProblemTypes: [
      "원의 중심/반지름/지름 찾기",
      "반지름과 지름의 관계 구하기",
      "원의 성질을 이용한 문제",
      "원 그리기",
    ],
  },
  {
    grade: 3, semester: 2, unitNumber: 4,
    unitTitle: "분수",
    domain: "수와 연산",
    learningObjectives: [
      "진분수, 가분수, 대분수를 알 수 있다",
      "가분수를 대분수로, 대분수를 가분수로 바꿀 수 있다",
      "분모가 같은 분수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["진분수", "가분수", "대분수", "분수의 종류", "분수의 크기 비교"],
    exampleProblemTypes: [
      "진분수/가분수/대분수 구별하기",
      "가분수 ↔ 대분수 변환",
      "분모가 같은 분수 크기 비교",
      "수직선에서 분수 나타내기",
    ],
  },
  {
    grade: 3, semester: 2, unitNumber: 5,
    unitTitle: "들이와 무게",
    domain: "도형과 측정",
    learningObjectives: [
      "들이의 단위 L와 mL를 알 수 있다",
      "무게의 단위 kg과 g을 알 수 있다",
      "들이와 무게를 어림하고 잴 수 있다",
    ],
    keyConcepts: [
      "들이", "리터(L)", "밀리리터(mL)", "1L = 1000mL",
      "킬로그램(kg)", "그램(g)", "1kg = 1000g",
    ],
    exampleProblemTypes: [
      "들이 단위 변환",
      "무게 단위 변환",
      "들이/무게의 합과 차",
      "실생활 들이/무게 문제",
    ],
  },
  {
    grade: 3, semester: 2, unitNumber: 6,
    unitTitle: "자료의 정리",
    domain: "자료와 가능성",
    learningObjectives: [
      "자료를 수집하여 표와 그래프로 나타낼 수 있다",
      "그림그래프를 그리고 해석할 수 있다",
      "자료를 보고 결론을 내릴 수 있다",
    ],
    keyConcepts: ["자료 수집", "표", "그림그래프", "자료 해석"],
    exampleProblemTypes: [
      "자료를 표로 정리하기",
      "그림그래프 그리기",
      "그래프 해석하기",
      "자료를 보고 결론 내리기",
    ],
  },

  // ═══════════════════════════════════════
  // 4학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 4, semester: 1, unitNumber: 1,
    unitTitle: "큰 수",
    domain: "수와 연산",
    learningObjectives: [
      "만, 십만, 백만, 천만, 억, 조를 알 수 있다",
      "큰 수를 읽고 쓸 수 있다",
      "큰 수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["만", "십만", "백만", "천만", "억", "조", "자릿값", "뛰어 세기"],
    exampleProblemTypes: [
      "큰 수 읽고 쓰기",
      "큰 수의 자릿값 구하기",
      "큰 수 크기 비교",
      "큰 수 뛰어 세기",
    ],
  },
  {
    grade: 4, semester: 1, unitNumber: 2,
    unitTitle: "각도",
    domain: "도형과 측정",
    learningObjectives: [
      "각의 크기를 비교하고 측정할 수 있다",
      "각도기를 사용하여 각도를 재고 그릴 수 있다",
      "예각, 둔각을 알 수 있다",
      "삼각형 세 각의 크기의 합이 180°임을 알 수 있다",
    ],
    keyConcepts: [
      "각도", "도(°)", "직각 = 90°", "예각",
      "둔각", "각도기", "삼각형 내각의 합 = 180°",
    ],
    exampleProblemTypes: [
      "각도 측정하기",
      "주어진 각도 그리기",
      "예각/둔각 구별하기",
      "삼각형 내각의 합을 이용한 문제",
    ],
  },
  {
    grade: 4, semester: 1, unitNumber: 3,
    unitTitle: "곱셈과 나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(세 자리 수) × (두 자리 수)를 할 수 있다",
      "(두/세 자리 수) ÷ (두 자리 수)를 할 수 있다",
      "곱셈과 나눗셈의 관계를 활용할 수 있다",
    ],
    keyConcepts: ["세 자리 수의 곱셈", "두 자리 수로 나누기", "곱셈과 나눗셈의 관계", "어림"],
    exampleProblemTypes: [
      "(세 자리 수) × (두 자리 수) 계산",
      "(두/세 자리 수) ÷ (두 자리 수) 계산",
      "나머지 있는 나눗셈",
      "곱셈/나눗셈 문장제",
    ],
  },
  {
    grade: 4, semester: 1, unitNumber: 4,
    unitTitle: "평면도형의 이동",
    domain: "도형과 측정",
    learningObjectives: [
      "평면도형을 밀기, 뒤집기, 돌리기 할 수 있다",
      "이동한 도형의 위치를 예상할 수 있다",
      "무늬 만들기에서 이동을 활용할 수 있다",
    ],
    keyConcepts: ["밀기(평행이동)", "뒤집기(대칭이동)", "돌리기(회전이동)", "무늬 만들기"],
    exampleProblemTypes: [
      "도형의 밀기 결과 예상",
      "도형의 뒤집기 결과 예상",
      "도형의 돌리기 결과 예상",
      "이동을 이용한 무늬 만들기",
    ],
  },
  {
    grade: 4, semester: 1, unitNumber: 5,
    unitTitle: "막대그래프",
    domain: "자료와 가능성",
    learningObjectives: [
      "자료를 조사하여 막대그래프로 나타낼 수 있다",
      "막대그래프를 보고 자료를 해석할 수 있다",
      "적절한 눈금 단위를 정할 수 있다",
    ],
    keyConcepts: ["막대그래프", "가로축", "세로축", "눈금", "자료 해석"],
    exampleProblemTypes: [
      "자료를 막대그래프로 나타내기",
      "막대그래프 읽고 해석하기",
      "두 막대그래프 비교하기",
      "적절한 눈금 정하기",
    ],
  },
  {
    grade: 4, semester: 1, unitNumber: 6,
    unitTitle: "규칙 찾기",
    domain: "변화와 관계",
    learningObjectives: [
      "수의 배열에서 규칙을 찾아 설명할 수 있다",
      "도형의 배열에서 규칙을 찾아 설명할 수 있다",
      "규칙에 따라 수나 도형을 배열할 수 있다",
    ],
    keyConcepts: ["수 배열의 규칙", "도형 배열의 규칙", "대응 관계", "규칙과 대응"],
    exampleProblemTypes: [
      "수 배열에서 규칙 찾기",
      "도형 배열에서 규칙 찾기",
      "규칙에 맞게 빈칸 채우기",
      "두 양 사이의 대응 관계 찾기",
    ],
  },

  // ═══════════════════════════════════════
  // 4학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 4, semester: 2, unitNumber: 1,
    unitTitle: "분수의 덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "분모가 같은 진분수끼리의 덧셈과 뺄셈을 할 수 있다",
      "분모가 같은 대분수끼리의 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["동분모 분수의 덧셈", "동분모 분수의 뺄셈", "진분수", "대분수", "가분수"],
    exampleProblemTypes: [
      "분모가 같은 진분수 덧셈/뺄셈",
      "분모가 같은 대분수 덧셈/뺄셈",
      "분수의 덧셈/뺄셈 문장제",
      "빈칸에 알맞은 분수 구하기",
    ],
  },
  {
    grade: 4, semester: 2, unitNumber: 2,
    unitTitle: "삼각형",
    domain: "도형과 측정",
    learningObjectives: [
      "이등변삼각형과 정삼각형을 알 수 있다",
      "삼각형을 변의 길이와 각의 크기에 따라 분류할 수 있다",
      "예각삼각형, 둔각삼각형을 알 수 있다",
    ],
    keyConcepts: ["이등변삼각형", "정삼각형", "예각삼각형", "직각삼각형", "둔각삼각형"],
    exampleProblemTypes: [
      "삼각형 분류하기",
      "이등변삼각형/정삼각형의 성질",
      "삼각형의 각도 구하기",
      "조건에 맞는 삼각형 그리기",
    ],
  },
  {
    grade: 4, semester: 2, unitNumber: 3,
    unitTitle: "소수의 덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "소수 두 자리 수, 세 자리 수를 알 수 있다",
      "소수의 크기를 비교할 수 있다",
      "소수의 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["소수 두 자리 수", "소수 세 자리 수", "소수 크기 비교", "소수의 덧셈", "소수의 뺄셈"],
    exampleProblemTypes: [
      "소수의 크기 비교",
      "소수의 덧셈 계산",
      "소수의 뺄셈 계산",
      "소수 덧셈/뺄셈 문장제",
    ],
  },
  {
    grade: 4, semester: 2, unitNumber: 4,
    unitTitle: "사각형",
    domain: "도형과 측정",
    learningObjectives: [
      "수직과 평행을 알 수 있다",
      "사다리꼴, 평행사변형, 마름모를 알 수 있다",
      "여러 가지 사각형의 성질을 이해할 수 있다",
    ],
    keyConcepts: ["수직", "평행", "사다리꼴", "평행사변형", "마름모", "직사각형", "정사각형"],
    exampleProblemTypes: [
      "수직/평행 관계 찾기",
      "사각형 분류하기",
      "평행사변형/마름모의 성질",
      "사각형의 변과 각의 관계",
    ],
  },
  {
    grade: 4, semester: 2, unitNumber: 5,
    unitTitle: "꺾은선그래프",
    domain: "자료와 가능성",
    learningObjectives: [
      "꺾은선그래프를 알고 내용을 해석할 수 있다",
      "자료를 꺾은선그래프로 나타낼 수 있다",
      "변화 추세를 예상할 수 있다",
    ],
    keyConcepts: ["꺾은선그래프", "변화 추세", "물결선", "눈금 단위"],
    exampleProblemTypes: [
      "꺾은선그래프 읽기",
      "자료를 꺾은선그래프로 나타내기",
      "변화 추세 예상하기",
      "두 꺾은선그래프 비교하기",
    ],
  },
  {
    grade: 4, semester: 2, unitNumber: 6,
    unitTitle: "다각형",
    domain: "도형과 측정",
    learningObjectives: [
      "다각형과 정다각형을 알 수 있다",
      "대각선의 성질을 이해할 수 있다",
      "모양 만들기와 채우기를 할 수 있다",
    ],
    keyConcepts: ["다각형", "정다각형", "대각선", "오각형", "육각형", "정오각형", "정육각형"],
    exampleProblemTypes: [
      "다각형/정다각형 구별하기",
      "대각선의 수 구하기",
      "정다각형의 성질",
      "모양 채우기",
    ],
  },

  // ═══════════════════════════════════════
  // 5학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 5, semester: 1, unitNumber: 1,
    unitTitle: "자연수의 혼합 계산",
    domain: "수와 연산",
    learningObjectives: [
      "덧셈, 뺄셈, 곱셈, 나눗셈이 섞인 식을 계산할 수 있다",
      "괄호가 있는 식을 계산할 수 있다",
      "계산 순서를 이해하고 올바르게 적용할 수 있다",
    ],
    keyConcepts: ["혼합 계산", "계산 순서", "괄호", "곱셈/나눗셈 먼저", "왼쪽에서 오른쪽으로"],
    exampleProblemTypes: [
      "혼합 계산 순서에 맞게 계산하기",
      "괄호가 있는 식 계산하기",
      "계산 순서 판단하기",
      "실생활 혼합 계산 문제",
    ],
  },
  {
    grade: 5, semester: 1, unitNumber: 2,
    unitTitle: "약수와 배수",
    domain: "수와 연산",
    learningObjectives: [
      "약수와 배수를 이해하고 구할 수 있다",
      "최대공약수를 구할 수 있다",
      "최소공배수를 구할 수 있다",
    ],
    keyConcepts: ["약수", "배수", "공약수", "최대공약수", "공배수", "최소공배수"],
    exampleProblemTypes: [
      "약수/배수 구하기",
      "최대공약수 구하기",
      "최소공배수 구하기",
      "약수/배수 활용 문장제",
    ],
  },
  {
    grade: 5, semester: 1, unitNumber: 3,
    unitTitle: "규칙과 대응",
    domain: "변화와 관계",
    learningObjectives: [
      "두 양 사이의 대응 관계를 식으로 나타낼 수 있다",
      "대응 관계를 □, △ 등의 기호로 표현할 수 있다",
      "대응 관계를 이용하여 문제를 해결할 수 있다",
    ],
    keyConcepts: ["대응 관계", "식으로 나타내기", "□와 △", "규칙", "변하는 양"],
    exampleProblemTypes: [
      "두 양의 대응 관계 찾기",
      "대응 관계를 식으로 나타내기",
      "규칙을 이용하여 값 구하기",
      "대응표 완성하기",
    ],
  },
  {
    grade: 5, semester: 1, unitNumber: 4,
    unitTitle: "약분과 통분",
    domain: "수와 연산",
    learningObjectives: [
      "크기가 같은 분수를 만들 수 있다",
      "약분을 하고 기약분수를 구할 수 있다",
      "통분을 하여 분수의 크기를 비교할 수 있다",
    ],
    keyConcepts: ["크기가 같은 분수", "약분", "기약분수", "통분", "공통분모"],
    exampleProblemTypes: [
      "크기가 같은 분수 찾기",
      "약분하여 기약분수 만들기",
      "통분하여 분수 크기 비교",
      "분수와 소수의 크기 비교",
    ],
  },
  {
    grade: 5, semester: 1, unitNumber: 5,
    unitTitle: "분수의 덧셈과 뺄셈",
    domain: "수와 연산",
    learningObjectives: [
      "분모가 다른 진분수끼리의 덧셈과 뺄셈을 할 수 있다",
      "분모가 다른 대분수끼리의 덧셈과 뺄셈을 할 수 있다",
    ],
    keyConcepts: ["이분모 분수의 덧셈", "이분모 분수의 뺄셈", "통분 후 계산"],
    exampleProblemTypes: [
      "분모가 다른 진분수 덧셈/뺄셈",
      "분모가 다른 대분수 덧셈/뺄셈",
      "분수의 덧셈/뺄셈 문장제",
      "빈칸에 알맞은 분수 구하기",
    ],
  },
  {
    grade: 5, semester: 1, unitNumber: 6,
    unitTitle: "다각형의 둘레와 넓이",
    domain: "도형과 측정",
    learningObjectives: [
      "정다각형의 둘레를 구할 수 있다",
      "직사각형, 정사각형의 넓이를 구할 수 있다",
      "평행사변형, 삼각형, 사다리꼴, 마름모의 넓이를 구할 수 있다",
      "1cm², 1m²를 알 수 있다",
    ],
    keyConcepts: ["둘레", "넓이", "cm²", "m²", "가로 × 세로", "밑변 × 높이", "넓이 공식"],
    exampleProblemTypes: [
      "직사각형/정사각형 넓이 구하기",
      "평행사변형 넓이 구하기",
      "삼각형 넓이 구하기",
      "사다리꼴/마름모 넓이 구하기",
    ],
  },

  // ═══════════════════════════════════════
  // 5학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 5, semester: 2, unitNumber: 1,
    unitTitle: "수의 범위와 어림하기",
    domain: "수와 연산",
    learningObjectives: [
      "이상, 이하, 초과, 미만을 이해할 수 있다",
      "올림, 버림, 반올림을 할 수 있다",
      "수의 범위를 활용하여 문제를 해결할 수 있다",
    ],
    keyConcepts: ["이상", "이하", "초과", "미만", "올림", "버림", "반올림"],
    exampleProblemTypes: [
      "수의 범위 나타내기",
      "올림/버림/반올림 계산",
      "어림하여 값 구하기",
      "수의 범위 활용 문제",
    ],
  },
  {
    grade: 5, semester: 2, unitNumber: 2,
    unitTitle: "분수의 곱셈",
    domain: "수와 연산",
    learningObjectives: [
      "(분수) × (자연수)를 계산할 수 있다",
      "(자연수) × (분수)를 계산할 수 있다",
      "(분수) × (분수)를 계산할 수 있다",
    ],
    keyConcepts: ["분수 × 자연수", "자연수 × 분수", "분수 × 분수", "약분 후 곱셈"],
    exampleProblemTypes: [
      "(진분수) × (자연수) 계산",
      "(대분수) × (자연수) 계산",
      "(분수) × (분수) 계산",
      "분수의 곱셈 문장제",
    ],
  },
  {
    grade: 5, semester: 2, unitNumber: 3,
    unitTitle: "합동과 대칭",
    domain: "도형과 측정",
    learningObjectives: [
      "합동인 도형을 알고 성질을 이해할 수 있다",
      "선대칭도형과 대칭축을 알 수 있다",
      "점대칭도형과 대칭의 중심을 알 수 있다",
    ],
    keyConcepts: ["합동", "대응점", "대응변", "대응각", "선대칭", "대칭축", "점대칭", "대칭의 중심"],
    exampleProblemTypes: [
      "합동인 도형 찾기",
      "대응점/대응변/대응각 찾기",
      "선대칭도형의 대칭축 찾기",
      "점대칭도형 그리기",
    ],
  },
  {
    grade: 5, semester: 2, unitNumber: 4,
    unitTitle: "소수의 곱셈",
    domain: "수와 연산",
    learningObjectives: [
      "(소수) × (자연수)를 계산할 수 있다",
      "(자연수) × (소수)를 계산할 수 있다",
      "(소수) × (소수)를 계산할 수 있다",
    ],
    keyConcepts: ["소수 × 자연수", "자연수 × 소수", "소수 × 소수", "소수점 위치"],
    exampleProblemTypes: [
      "(소수) × (자연수) 계산",
      "(소수) × (소수) 계산",
      "소수점 위치 결정하기",
      "소수의 곱셈 문장제",
    ],
  },
  {
    grade: 5, semester: 2, unitNumber: 5,
    unitTitle: "직육면체",
    domain: "도형과 측정",
    learningObjectives: [
      "직육면체와 정육면체를 알 수 있다",
      "직육면체의 성질을 이해할 수 있다",
      "직육면체의 겨냥도와 전개도를 그릴 수 있다",
    ],
    keyConcepts: ["직육면체", "정육면체", "면", "모서리", "꼭짓점", "겨냥도", "전개도"],
    exampleProblemTypes: [
      "직육면체의 면/모서리/꼭짓점 수 구하기",
      "직육면체의 성질 파악하기",
      "전개도 그리기",
      "전개도로 직육면체 만들기",
    ],
  },
  {
    grade: 5, semester: 2, unitNumber: 6,
    unitTitle: "평균과 가능성",
    domain: "자료와 가능성",
    learningObjectives: [
      "평균의 의미를 알고 구할 수 있다",
      "평균을 활용하여 문제를 해결할 수 있다",
      "사건이 일어날 가능성을 말로 표현할 수 있다",
    ],
    keyConcepts: ["평균", "합계 ÷ 개수", "가능성", "확실하다", "불가능하다", "~일 것 같다"],
    exampleProblemTypes: [
      "평균 구하기",
      "평균을 이용한 문제 풀기",
      "가능성의 정도 비교하기",
      "실생활 평균 문제",
    ],
  },

  // ═══════════════════════════════════════
  // 6학년 1학기
  // ═══════════════════════════════════════
  {
    grade: 6, semester: 1, unitNumber: 1,
    unitTitle: "분수의 나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(자연수) ÷ (자연수)의 몫을 분수로 나타낼 수 있다",
      "(분수) ÷ (자연수)를 계산할 수 있다",
    ],
    keyConcepts: ["분수의 나눗셈", "나눗셈의 몫을 분수로", "분수 ÷ 자연수"],
    exampleProblemTypes: [
      "나눗셈의 몫을 분수로 나타내기",
      "(진분수) ÷ (자연수) 계산",
      "(대분수) ÷ (자연수) 계산",
      "분수의 나눗셈 문장제",
    ],
  },
  {
    grade: 6, semester: 1, unitNumber: 2,
    unitTitle: "각기둥과 각뿔",
    domain: "도형과 측정",
    learningObjectives: [
      "각기둥을 알고 구성 요소를 이해할 수 있다",
      "각기둥의 전개도를 그릴 수 있다",
      "각뿔을 알고 구성 요소를 이해할 수 있다",
    ],
    keyConcepts: ["각기둥", "각뿔", "밑면", "옆면", "높이", "전개도", "삼각기둥", "사각기둥"],
    exampleProblemTypes: [
      "각기둥의 면/모서리/꼭짓점 수 구하기",
      "각기둥의 전개도 그리기",
      "각뿔의 면/모서리/꼭짓점 수 구하기",
      "각기둥과 각뿔의 비교",
    ],
  },
  {
    grade: 6, semester: 1, unitNumber: 3,
    unitTitle: "소수의 나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(소수) ÷ (자연수)를 계산할 수 있다",
      "(자연수) ÷ (자연수)의 몫을 소수로 나타낼 수 있다",
      "몫을 반올림하여 나타낼 수 있다",
    ],
    keyConcepts: ["소수의 나눗셈", "소수점 위치", "몫의 반올림", "나눗셈과 소수"],
    exampleProblemTypes: [
      "(소수) ÷ (자연수) 계산",
      "몫을 소수로 나타내기",
      "몫을 반올림하여 나타내기",
      "소수의 나눗셈 문장제",
    ],
  },
  {
    grade: 6, semester: 1, unitNumber: 4,
    unitTitle: "비와 비율",
    domain: "변화와 관계",
    learningObjectives: [
      "두 수를 비로 나타낼 수 있다",
      "비율을 분수, 소수, 백분율로 나타낼 수 있다",
      "비율을 활용하여 문제를 해결할 수 있다",
    ],
    keyConcepts: ["비", "비율", "기준량", "비교하는 양", "백분율(%)", "비율 = 비교하는 양 ÷ 기준량"],
    exampleProblemTypes: [
      "비로 나타내기",
      "비율 구하기",
      "백분율로 나타내기",
      "비율 활용 문장제",
    ],
  },
  {
    grade: 6, semester: 1, unitNumber: 5,
    unitTitle: "여러 가지 그래프",
    domain: "자료와 가능성",
    learningObjectives: [
      "띠그래프와 원그래프를 알 수 있다",
      "자료를 띠그래프와 원그래프로 나타낼 수 있다",
      "여러 가지 그래프를 비교하고 적절한 그래프를 선택할 수 있다",
    ],
    keyConcepts: ["띠그래프", "원그래프", "백분율", "자료 해석", "그래프 비교"],
    exampleProblemTypes: [
      "띠그래프 읽고 해석하기",
      "원그래프 읽고 해석하기",
      "자료를 그래프로 나타내기",
      "적절한 그래프 선택하기",
    ],
  },
  {
    grade: 6, semester: 1, unitNumber: 6,
    unitTitle: "직육면체의 부피와 겉넓이",
    domain: "도형과 측정",
    learningObjectives: [
      "부피의 단위 1cm³, 1m³를 알 수 있다",
      "직육면체와 정육면체의 부피를 구할 수 있다",
      "직육면체의 겉넓이를 구할 수 있다",
    ],
    keyConcepts: ["부피", "cm³", "m³", "가로 × 세로 × 높이", "겉넓이", "전개도와 겉넓이"],
    exampleProblemTypes: [
      "직육면체 부피 구하기",
      "정육면체 부피 구하기",
      "부피 단위 변환",
      "직육면체 겉넓이 구하기",
    ],
  },

  // ═══════════════════════════════════════
  // 6학년 2학기
  // ═══════════════════════════════════════
  {
    grade: 6, semester: 2, unitNumber: 1,
    unitTitle: "분수의 나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(분수) ÷ (분수)를 계산할 수 있다",
      "분수의 나눗셈을 분수의 곱셈으로 바꿔 계산할 수 있다",
      "분수의 나눗셈을 활용하여 문제를 해결할 수 있다",
    ],
    keyConcepts: ["분수 ÷ 분수", "역수", "나눗셈을 곱셈으로", "역수를 곱하기"],
    exampleProblemTypes: [
      "(진분수) ÷ (진분수) 계산",
      "(대분수) ÷ (분수) 계산",
      "역수를 이용한 나눗셈",
      "분수의 나눗셈 문장제",
    ],
  },
  {
    grade: 6, semester: 2, unitNumber: 2,
    unitTitle: "소수의 나눗셈",
    domain: "수와 연산",
    learningObjectives: [
      "(소수) ÷ (소수)를 계산할 수 있다",
      "자연수의 나눗셈을 이용하여 소수의 나눗셈을 할 수 있다",
      "몫을 반올림하여 나타낼 수 있다",
    ],
    keyConcepts: ["소수 ÷ 소수", "소수점 이동", "자연수로 변환하여 계산", "몫의 반올림"],
    exampleProblemTypes: [
      "(소수) ÷ (소수) 계산",
      "소수점 이동하여 계산하기",
      "몫을 반올림하기",
      "소수의 나눗셈 문장제",
    ],
  },
  {
    grade: 6, semester: 2, unitNumber: 3,
    unitTitle: "공간과 입체",
    domain: "도형과 측정",
    learningObjectives: [
      "쌓기나무로 만든 입체도형의 모양을 알 수 있다",
      "위, 앞, 옆에서 본 모양을 그릴 수 있다",
      "층별로 나타낸 모양을 이해할 수 있다",
    ],
    keyConcepts: ["쌓기나무", "위에서 본 모양", "앞에서 본 모양", "옆에서 본 모양", "공간 감각"],
    exampleProblemTypes: [
      "쌓기나무의 수 구하기",
      "위/앞/옆에서 본 모양 그리기",
      "보이는 모양으로 입체도형 추론하기",
      "층별 쌓기나무 수 구하기",
    ],
  },
  {
    grade: 6, semester: 2, unitNumber: 4,
    unitTitle: "비례식과 비례배분",
    domain: "변화와 관계",
    learningObjectives: [
      "비례식을 알고 성질을 이해할 수 있다",
      "비례식의 성질을 이용하여 미지수를 구할 수 있다",
      "비례배분을 이해하고 활용할 수 있다",
    ],
    keyConcepts: ["비례식", "외항", "내항", "외항의 곱 = 내항의 곱", "비례배분"],
    exampleProblemTypes: [
      "비례식 세우기",
      "비례식에서 미지수 구하기",
      "비례배분으로 나누기",
      "비례식/비례배분 문장제",
    ],
  },
  {
    grade: 6, semester: 2, unitNumber: 5,
    unitTitle: "원의 넓이",
    domain: "도형과 측정",
    learningObjectives: [
      "원주와 원주율을 알 수 있다",
      "원주와 지름의 관계를 이해할 수 있다",
      "원의 넓이를 구하는 방법을 이해하고 구할 수 있다",
    ],
    keyConcepts: [
      "원주", "원주율(π)", "원주 = 지름 × π",
      "원의 넓이 = 반지름 × 반지름 × π", "3.14",
    ],
    exampleProblemTypes: [
      "원주 구하기",
      "원의 넓이 구하기",
      "반지름/지름으로부터 원주/넓이 구하기",
      "원의 넓이 활용 문제",
    ],
  },
  {
    grade: 6, semester: 2, unitNumber: 6,
    unitTitle: "원기둥, 원뿔, 구",
    domain: "도형과 측정",
    learningObjectives: [
      "원기둥을 알고 구성 요소와 성질을 이해할 수 있다",
      "원기둥의 전개도를 그릴 수 있다",
      "원뿔을 알고 구성 요소를 이해할 수 있다",
      "구를 알고 구성 요소를 이해할 수 있다",
    ],
    keyConcepts: ["원기둥", "원뿔", "구", "밑면", "옆면", "높이", "모선", "전개도"],
    exampleProblemTypes: [
      "원기둥의 구성 요소 파악하기",
      "원기둥의 전개도 그리기",
      "원뿔의 구성 요소 파악하기",
      "원기둥/원뿔/구 비교하기",
    ],
  },
];
