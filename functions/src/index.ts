import {genkit, z} from "genkit";
import {googleAI} from "@genkit-ai/google-genai";
import {onCallGenkit} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/scheduler";
import {setGlobalOptions} from "firebase-functions";
import * as admin from "firebase-admin";
import {FieldValue} from "firebase-admin/firestore";

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({maxInstances: 10});

const ai = genkit({
  plugins: [googleAI()],
  model: googleAI.model("gemini-2.5-flash"),
});

// ─── 스키마 정의 ───

const OptionSchema = z.object({
  label: z.string().describe("선택지 라벨 (A, B, C, D)"),
  text: z.string().describe("선택지 텍스트"),
  svg: z.string().optional().describe("선택지를 설명하는 SVG 코드 (필요한 경우만)"),
});

const QuestionSchema = z.object({
  text: z.string().describe("문제 텍스트"),
  svg: z.string().optional()
    .describe("문제를 시각적으로 설명하는 SVG 코드 (필요한 경우만)"),
  type: z.enum(["multiple_choice", "short_answer"]).describe("문제 유형"),
  options: z.array(OptionSchema).optional()
    .describe("객관식 선택지 (type이 multiple_choice인 경우 4개)"),
});

const SolutionSchema = z.object({
  answer: z.string()
    .describe("정답 (객관식: A~D 라벨, 주관식: 정답 값)"),
  explanation: z.string().describe("풀이 과정 설명"),
  explanationSvg: z.string().optional()
    .describe("풀이 과정을 시각적으로 설명하는 SVG 코드 (필요한 경우만)"),
});

const MetadataSchema = z.object({
  topic: z.string()
    .describe("수학 주제 (교육과정 단원명)"),
  difficulty: z.number().min(1).max(5)
    .describe("난이도 (1~5)"),
  gradeLevel: z.number().min(1).max(12)
    .describe("학년 (1~12, 초등 1~6 / 중등 7~9 / 고등 10~12)"),
  tags: z.array(z.string())
    .describe("문제 관련 태그"),
  domain: z.string()
    .describe("교육과정 영역"),
  learningObjective: z.string()
    .describe("학습 목표"),
});

const ProblemOutputSchema = z.object({
  question: QuestionSchema,
  solution: SolutionSchema,
  metadata: MetadataSchema,
});

// ─── 유틸리티 ───

/**
 * 생년월일로부터 나이를 계산합니다.
 * @param {string} birthDate YYYY-MM-DD 형식
 * @return {number} 만 나이
 */
function calculateAge(birthDate: string): number {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

/**
 * 나이를 학년으로 변환합니다.
 * 초등 1~6 (만 7~12세), 중등 7~9 (만 13~15세), 고등 10~12 (만 16~18세)
 * @param {number} age 만 나이
 * @return {number} 학년 (1~12)
 */
function ageToGradeLevel(age: number): number {
  const grade = age - 6;
  if (grade < 1) return 1;
  if (grade > 12) return 12;
  return grade;
}

/**
 * 난이도를 1~5 범위로 제한합니다.
 * @param {number} d 난이도
 * @return {number} 제한된 난이도
 */
function clampDifficulty(d: number): number {
  return Math.max(1, Math.min(5, d));
}

// ─── 교육과정 조회 ───

interface CurriculumContext {
  unitTitle: string;
  domain: string;
  learningObjectives: string[];
  keyConcepts: string[];
  exampleProblemTypes: string[];
}

/**
 * 간격 반복 + 교차 연습 기반으로 교육과정 단원을 스마트 선택합니다.
 * 토픽 마스터리와 마지막 풀이 시간을 분석하여 최적의 단원을 선택합니다.
 * @param {string} uid 사용자 UID
 * @param {number} gradeLevel 학년 (1~6)
 * @return {Promise<CurriculumContext | null>} 교육과정 컨텍스트 또는 null
 */
async function findSmartCurriculum(
  uid: string,
  gradeLevel: number,
): Promise<CurriculumContext | null> {
  try {
    // 1) 교육과정 + 토픽 통계 + 최근 이력 병렬 조회
    const [currSnap, topicSnap, recentSnap] = await Promise.all([
      db.collection("curriculum")
        .where("grade", "==", gradeLevel)
        .get(),
      db.collection("users")
        .doc(uid).collection("topicStats").get(),
      // 최근 5문제의 주제를 가져와서 반복 방지
      db.collection("users").doc(uid)
        .collection("history")
        .orderBy("answeredAt", "desc")
        .limit(5)
        .get(),
    ]);
    if (currSnap.empty) return null;

    // 2) 토픽 마스터리 통계
    const topicMap: Record<string, {
      total: number;
      correct: number;
      lastPracticed: Date | null;
    }> = {};
    for (const doc of topicSnap.docs) {
      const d = doc.data();
      topicMap[doc.id] = {
        total: d.total ?? 0,
        correct: d.correct ?? 0,
        lastPracticed: d.lastPracticed?.toDate() ?? null,
      };
    }

    // 3) 최근 출제된 주제 수집 (반복 방지)
    const recentTopics = new Set<string>();
    if (!recentSnap.empty) {
      const problemIds = [
        ...new Set(
          recentSnap.docs.map((d) => d.data().problemId).filter(Boolean)
        ),
      ];
      if (problemIds.length > 0) {
        const refs = problemIds.map(
          (id) => db.collection("problems").doc(id)
        );
        const snaps = await db.getAll(...refs);
        for (const snap of snaps) {
          if (snap.exists) {
            const topic = snap.data()?.metadata?.topic;
            if (topic) recentTopics.add(topic);
          }
        }
      }
    }

    // 4) 영역별 단원 수 집계 (영역 균형용)
    const domainCounts: Record<string, number> = {};
    for (const doc of currSnap.docs) {
      const domain = doc.data().domain as string;
      domainCounts[domain] = (domainCounts[domain] ?? 0) + 1;
    }
    const domainKeys = Object.keys(domainCounts).length;
    const avgCount = currSnap.size / Math.max(domainKeys, 1);

    // 5) 각 단원에 우선순위 점수 계산
    const now = Date.now();
    const hourMs = 3600000;
    interface ScoredUnit {
      data: FirebaseFirestore.DocumentData;
      score: number;
    }
    const scored: ScoredUnit[] = currSnap.docs.map((doc) => {
      const data = doc.data();
      const title = data.unitTitle as string;
      const domain = data.domain as string;
      const stats = topicMap[title];

      let score = 50; // 기본: 새로운 토픽

      if (stats && stats.total > 0) {
        const mastery = stats.correct / stats.total;
        const hoursSince = stats.lastPracticed ?
          (now - stats.lastPracticed.getTime()) / hourMs : 168;

        const timeFactor = Math.min(hoursSince / 24, 1) * 50;

        if (mastery < 0.6) {
          score = 80 + timeFactor;
        } else if (mastery < 0.8) {
          score = 50 + timeFactor;
        } else {
          score = 5 + timeFactor * 0.3;
        }
      }

      // ★ 최근 출제된 주제 페널티 (같은 주제 연속 방지)
      if (recentTopics.has(title)) {
        score *= 0.15;
      }

      // ★ 영역 균형 보너스 (단원 수가 적은 영역에 보너스)
      const domainCount = domainCounts[domain] ?? 1;
      if (domainCount < avgCount) {
        score *= 1.3;
      }

      return {data, score};
    });

    // 6) 가중 랜덤 선택
    const totalScore = scored.reduce((s, u) => s + u.score, 0);
    let rand = Math.random() * totalScore;
    let chosen = scored[0];
    for (const unit of scored) {
      rand -= unit.score;
      if (rand <= 0) {
        chosen = unit;
        break;
      }
    }

    return {
      unitTitle: chosen.data.unitTitle,
      domain: chosen.data.domain,
      learningObjectives: chosen.data.learningObjectives,
      keyConcepts: chosen.data.keyConcepts,
      exampleProblemTypes: chosen.data.exampleProblemTypes,
    };
  } catch (e) {
    console.warn("교육과정 조회 실패 (무시):", e);
    return null;
  }
}

// ─── 학습 이력 조회 ───

interface HistoryContext {
  questionText: string;
  topic: string;
  difficulty: number;
  isCorrect: boolean;
  userAnswer: string;
  correctAnswer: string;
}

/**
 * 사용자의 최근 N개 풀이 기록을 문제 데이터와 함께 조회합니다.
 * @param {string} uid 사용자 UID
 * @param {number} limit 조회할 기록 수
 * @return {Promise<HistoryContext[]>} 최근 풀이 기록
 */
async function getRecentHistory(
  uid: string,
  limit = 10,
): Promise<HistoryContext[]> {
  try {
    const historySnap = await db
      .collection("users").doc(uid)
      .collection("history")
      .orderBy("answeredAt", "desc")
      .limit(limit)
      .get();

    if (historySnap.empty) return [];

    // 배치 조회: 모든 problemId를 모아서 한 번에 가져오기
    const historyDocs = historySnap.docs.map((doc) => doc.data());
    const problemIds = [
      ...new Set(historyDocs.map((h) => h.problemId).filter(Boolean)),
    ];

    if (problemIds.length === 0) return [];

    const problemRefs = problemIds.map(
      (id) => db.collection("problems").doc(id)
    );
    const problemSnaps = await db.getAll(...problemRefs);

    const problemMap: Record<string, FirebaseFirestore.DocumentData> = {};
    for (const snap of problemSnaps) {
      if (snap.exists) {
        problemMap[snap.id] = snap.data()!;
      }
    }

    const results: HistoryContext[] = [];
    for (const hist of historyDocs) {
      const prob = problemMap[hist.problemId];
      if (!prob) continue;

      results.push({
        questionText: prob.question?.text ?? "",
        topic: prob.metadata?.topic ?? "",
        difficulty: prob.metadata?.difficulty ?? 0,
        isCorrect: hist.isCorrect,
        userAnswer: hist.userAnswer,
        correctAnswer: prob.solution?.answer ?? "",
      });
    }
    return results;
  } catch (e) {
    console.warn("학습 이력 조회 실패 (무시):", e);
    return [];
  }
}

// ─── 문제 생성 + problems 컬렉션 저장 + 전체 임베딩 ───

const CurriculumCacheSchema = z.object({
  unitTitle: z.string(),
  domain: z.string(),
  learningObjectives: z.array(z.string()),
  keyConcepts: z.array(z.string()),
  exampleProblemTypes: z.array(z.string()),
});

const GenerateInputSchema = z.object({
  birthDate: z.string().describe("사용자 생년월일 (YYYY-MM-DD)"),
  previousCorrect: z.boolean().optional()
    .describe("직전 문제를 맞혔는지 여부 (첫 문제면 생략)"),
  currentDifficulty: z.number().optional()
    .describe("현재 난이도 (1~5, 첫 문제면 생략)"),
  gradeLevel: z.number().optional()
    .describe("학년 오버라이드 (1~12, 생략 시 생년월일 기반 자동 계산)"),
  includeHistory: z.boolean().optional()
    .describe("최근 풀이 이력을 프롬프트에 포함할지 여부"),
  cachedCurriculum: CurriculumCacheSchema.optional()
    .describe("캐싱된 교육과정 정보 (풀 모드에서 재활용)"),
});

const GenerateOutputSchema = z.object({
  problemId: z.string().describe("problems 컬렉션에 저장된 문제 ID"),
  problem: ProblemOutputSchema,
  curriculum: CurriculumCacheSchema.optional()
    .describe("풀 모드에서 재활용할 수 있는 교육과정 정보"),
});

const generateProblemFlow = ai.defineFlow(
  {
    name: "generateProblem",
    inputSchema: GenerateInputSchema,
    outputSchema: GenerateOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const age = calculateAge(input.birthDate);
    const gradeLevel = input.gradeLevel ??
      ageToGradeLevel(age);

    // 적응형 난이도
    let difficulty: number;
    if (input.currentDifficulty != null &&
        input.previousCorrect != null) {
      // 적응형: 맞혔으면 +1, 틀렸으면 -1
      difficulty = input.previousCorrect ?
        clampDifficulty(input.currentDifficulty + 1) :
        clampDifficulty(input.currentDifficulty - 1);
    } else if (input.currentDifficulty != null) {
      // 풀 모드: 지정된 난이도 그대로 사용
      difficulty = clampDifficulty(input.currentDifficulty);
    } else {
      // 첫 문제: 학년 기준
      difficulty = Math.min(gradeLevel, 5);
    }

    const difficultyLabel = [
      "", "매우 쉬운", "쉬운", "보통", "어려운", "매우 어려운",
    ][difficulty];

    // ★ 교육과정 + 학습 이력 병렬 조회 (캐시가 있으면 DB 조회 건너뜀)
    const [curriculum, history] = await Promise.all([
      input.cachedCurriculum ??
        findSmartCurriculum(uid, gradeLevel),
      input.includeHistory ? getRecentHistory(uid, 10) : Promise.resolve([]),
    ]);

    const curriculumSection = curriculum ? `
## 교육과정 정보 (2022 개정 교육과정)
- 단원: ${curriculum.unitTitle} (${curriculum.domain})
- 학습 목표:
${curriculum.learningObjectives.map((obj) => `  - ${obj}`).join("\n")}
- 핵심 개념: ${curriculum.keyConcepts.join(", ")}
- 출제 가능 문제 유형:
${curriculum.exampleProblemTypes.map((pt) => `  - ${pt}`).join("\n")}

위 교육과정 정보를 참고하여 문제를 출제하세요.
문제 유형은 위에 나열된 유형 중 하나를 선택하세요.
metadata.topic은 "${curriculum.unitTitle}"로 설정하세요.
metadata.domain은 "${curriculum.domain}"으로 설정하세요.
metadata.learningObjective는 위 학습 목표 중
이 문제에 가장 관련 있는 하나를 선택하세요.
` : `
## 교육과정 메타데이터 설정
metadata.domain은 문제의 수학 영역으로 설정하세요.
(수와 연산, 도형과 측정, 자료와 가능성,
변화와 관계 중 택1)
metadata.learningObjective는
이 문제의 핵심 학습 목표를 한 문장으로 작성하세요.
`;

    // ★ 학습 이력 섹션 구성
    let historySection = "";
    if (input.includeHistory && history.length > 0) {
      {
        const correct = history.filter((h) => h.isCorrect);
        const incorrect = history.filter((h) => !h.isCorrect);

        const fmt = (h: HistoryContext) =>
          `  - [${h.topic}, 난이도${h.difficulty}]` +
          ` "${h.questionText}"`;

        historySection = `
## 학생의 최근 학습 이력
### 맞힌 문제 (${correct.length}개):
${correct.length > 0 ?
    correct.map(fmt).join("\n") : "  - (없음)"}

### 틀린 문제 (${incorrect.length}개):
${incorrect.length > 0 ?
    incorrect.map(fmt).join("\n") : "  - (없음)"}

### 출제 지침:
- 틀린 주제가 있다면 해당 주제를 다시 연습할 수 있는 문제를 우선 출제
- 연속으로 맞힌 주제는 피하고 새로운 주제나 더 높은 난이도를 시도
- 같은 문제를 반복하지 마세요
`;
      }
    }

    // 1) Gemini로 문제 생성
    const {output} = await ai.generate({
      prompt: `당신은 한국 초등학교 수학 교사입니다.
만 ${age}세 (${gradeLevel}학년) 학생에게 적합한 ${difficultyLabel} 수학 문제를 하나 만들어 주세요.

난이도: ${difficulty}/5
${curriculumSection}
${historySection}
## 텍스트 작성 규칙 (매우 중요!)
- 특수 유니코드 문자를 절대 사용하지 마세요.
- 한글, 숫자, 기본 영문, 기본 기호만 사용하세요.
- 허용 기호: +, -, =, <, >, (, ), /, *, ., ?, !, cm, km, kg, m 등
- 수식은 일반 텍스트로 자연스럽게 작성하세요.
  예: "3 + 5 = ?", "3/4 + 1/2의 값은?", "24 x 6 = ?"
- 곱셈은 "x" 또는 "×" 대신 소문자 "x"를 사용하세요.
- 나눗셈은 "/" 또는 "÷"를 사용하세요.
- 분수는 "3/4", "1/2" 처럼 슬래시로 표기하세요.
- 제곱은 "cm2", "m2" 처럼 숫자를 바로 붙여 쓰세요. 유니코드 위첨자(², ³)는 사용하지 마세요.
- LaTeX 문법($, \frac, \times 등)은 절대 사용하지 마세요.
- 볼드, 이탤릭 등 유니코드 수학 기호(𝐚, 𝑏, 𝟏 등)는 절대 사용하지 마세요.
- 선택지(options)의 text와 풀이 과정(explanation)에도 같은 규칙을 적용하세요.

## SVG 도형 규칙 (매우 중요!)
다음 주제의 문제에는 **반드시** question.svg에 SVG 도형을 포함하세요:
- 도형 (삼각형, 사각형, 원, 다각형 등)
- 넓이/둘레/부피 계산
- 각도
- 대칭/회전
- 패턴 찾기
- 그래프/표 읽기
- 시계/시간 문제
- 길이 비교

SVG 작성 규칙:
- viewBox="0 0 300 200" 사용
- 도형은 선명한 색상 사용: stroke="#6C63FF"(보라), fill="#E8E7F0"(연보라)
- 보조색: "#FF6B6B"(빨강), "#4ECDC4"(민트), "#FFD93D"(노랑), "#2ECC71"(초록)
- 모든 <text> 태그에 반드시 font-family="'Noto Sans KR', sans-serif" 속성을 추가하세요
- 치수/라벨은 <text> 태그로 표시 (font-size="14", fill="#2D2D3A")
- SVG 안의 텍스트도 특수 유니코드 문자를 사용하지 마세요. 일반 한글과 숫자만 사용하세요.
- 화살표, 점선 등 보조선을 활용해 교육적으로 명확하게
- stroke-width="2"로 선을 굵게 표시
- 예시: 직사각형 넓이 문제라면 직사각형 SVG에 가로/세로 치수를 표시

선택지에 SVG가 필요한 경우 (도형을 보고 고르는 문제 등):
- 각 옵션의 svg 필드에 개별 SVG 코드를 넣으세요.
- 각 선택지 SVG는 viewBox="0 0 150 100" 사용

풀이 설명에 도형이 도움되는 경우:
- explanationSvg에 풀이 과정을 시각화한 SVG를 포함하세요.
- 풀이 SVG에는 단계별 표시(색상으로 구분)를 추가하세요.

## 문제 출제 규칙
- 문제는 한국어로 작성
- 반드시 객관식(4지선다)으로 출제
- type은 반드시 "multiple_choice"로 설정
- 반드시 options 배열에 A, B, C, D 4개의 선택지를 포함
- answer는 반드시 정답 선택지의 라벨(A, B, C, D 중 하나)로 설정
- metadata.difficulty는 반드시 ${difficulty}로 설정
- metadata.gradeLevel은 반드시 ${gradeLevel}로 설정

## 학년별 출제 범위
- 1학년: 한 자리 수 덧셈/뺄셈, 도형 이름 맞추기
- 2학년: 두 자리 수 덧셈/뺄셈, 곱셈 구구단, 시계 읽기
- 3학년: 세 자리 수 연산, 나눗셈, 분수 개념, 원/삼각형/사각형
- 4학년: 큰 수 연산, 분수 연산, 각도, 삼각형/사각형 분류, 꺾은선 그래프
- 5학년: 약수/배수, 분수 사칙연산, 소수, 대칭, 넓이
- 6학년: 비와 비율, 원의 넓이, 비례식, 경우의 수, 입체도형

## 풀이 과정
- 학생이 이해할 수 있도록 단계별로 설명
- 수식을 포함하여 풀이 과정을 명확하게 작성
- 핵심 개념을 한 줄로 요약하여 마무리`,
      output: {schema: ProblemOutputSchema},
    });

    if (!output) {
      throw new Error("문제 생성에 실패했습니다.");
    }

    // 2) 전체 문제(문제 + 답 + 풀이)를 임베딩
    const embeddingText = [
      output.question.text,
      output.solution.answer,
      output.solution.explanation,
      output.metadata.topic,
      output.metadata.domain,
      output.metadata.learningObjective,
      ...output.metadata.tags,
    ].join(" ");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const problemData: Record<string, any> = {
      question: output.question,
      solution: output.solution,
      metadata: output.metadata,
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    };

    try {
      const embedResult = await ai.embed({
        embedder: googleAI.embedder("text-embedding-005"),
        content: embeddingText,
      });
      const embedding = embedResult[0]?.embedding ?? [];
      if (embedding.length > 0) {
        problemData.embedding = FieldValue.vector(embedding);
      }
    } catch (e) {
      console.warn("임베딩 생성 실패 (무시):", e);
    }

    // 3) problems 컬렉션에 저장
    const docRef = await db.collection("problems")
      .add(problemData);

    return {
      problemId: docRef.id,
      problem: output,
      curriculum: curriculum ?? undefined,
    };
  }
);

export const generateProblem = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  generateProblemFlow
);

const operationLabels: Record<string, string> = {
  addition: "덧셈",
  subtraction: "뺄셈",
  multiplication: "곱셈",
  division: "나눗셈",
  mixed: "혼합 연산",
};

// ─── 일괄 문제 생성 (풀 채우기용 — 1회 LLM 호출로 N문제) ───

const BatchInputSchema = z.object({
  birthDate: z.string(),
  count: z.number().min(1).max(10).default(5),
  difficulty: z.number().min(1).max(5),
  cachedCurriculum: CurriculumCacheSchema.optional(),
});

const BatchOutputSchema = z.object({
  problems: z.array(z.object({
    problemId: z.string(),
    problem: ProblemOutputSchema,
  })),
  curriculum: CurriculumCacheSchema.optional(),
});

const BatchProblemArraySchema = z.object({
  problems: z.array(ProblemOutputSchema),
});

const generateBatchFlow = ai.defineFlow(
  {
    name: "generateBatch",
    inputSchema: BatchInputSchema,
    outputSchema: BatchOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const age = calculateAge(input.birthDate);
    const gradeLevel = ageToGradeLevel(age);
    const difficulty = clampDifficulty(input.difficulty);
    const count = input.count;

    const difficultyLabel = [
      "", "매우 쉬운", "쉬운", "보통", "어려운", "매우 어려운",
    ][difficulty];

    // 교육과정 조회 (캐시 우선)
    const curriculum = input.cachedCurriculum ??
      await findSmartCurriculum(uid, gradeLevel);

    const curriculumSection = curriculum ? `
## 교육과정 정보
- 단원: ${curriculum.unitTitle} (${curriculum.domain})
- 학습 목표: ${curriculum.learningObjectives.join(", ")}
- 핵심 개념: ${curriculum.keyConcepts.join(", ")}
- 출제 가능 문제 유형: ${curriculum.exampleProblemTypes.join(", ")}
각 문제의 metadata.topic은 "${curriculum.unitTitle}",
metadata.domain은 "${curriculum.domain}"으로 설정하세요.
` : `
metadata.domain은 수학 영역(수와 연산, 도형과 측정, 자료와 가능성, 변화와 관계 중 택1)으로 설정하세요.
`;

    const {output} = await ai.generate({
      prompt: `당신은 한국 초등학교 수학 교사입니다.
만 ${age}세 (${gradeLevel}학년) 학생에게 적합한
${difficultyLabel} 수학 문제를 **${count}개** 만들어 주세요.

난이도: ${difficulty}/5
${curriculumSection}

## 중요: ${count}개의 서로 다른 문제를 만드세요!
- 각 문제는 다른 주제/유형이어야 합니다
- 같은 패턴의 문제를 반복하지 마세요

## 텍스트 작성 규칙
- 특수 유니코드 문자 사용 금지. 한글, 숫자, 기본 기호만 사용
- 허용 기호: +, -, =, <, >, (, ), /, *, ., ?, !, cm, km, kg, m
- 곱셈은 "x", 나눗셈은 "/", 분수는 "3/4" 형식
- LaTeX, 유니코드 수학 기호 절대 금지

## SVG 규칙
도형/넓이/각도/그래프 문제에는 question.svg 포함:
- viewBox="0 0 300 200", stroke="#6C63FF", fill="#E8E7F0"
- <text>에 font-family="'Noto Sans KR', sans-serif"

## 문제 규칙
- 한국어, 객관식(4지선다), type="multiple_choice"
- options에 A,B,C,D 4개, answer는 정답 라벨
- metadata.difficulty=${difficulty}, metadata.gradeLevel=${gradeLevel}

## 학년별 범위
- 1학년: 한 자리 수 덧셈/뺄셈, 도형 이름
- 2학년: 두 자리 수 연산, 구구단, 시계
- 3학년: 세 자리 수, 나눗셈, 분수 개념, 도형
- 4학년: 큰 수, 분수 연산, 각도, 꺾은선 그래프
- 5학년: 약수/배수, 분수 사칙연산, 소수, 대칭, 넓이
- 6학년: 비와 비율, 원의 넓이, 비례식, 경우의 수

## 풀이: 학생이 이해할 수 있게 단계별 설명`,
      output: {schema: BatchProblemArraySchema},
    });

    if (!output || !output.problems || output.problems.length === 0) {
      throw new Error("일괄 문제 생성에 실패했습니다.");
    }

    // Firestore에 병렬 저장
    const results = await Promise.all(
      output.problems.map(async (problem) => {
        const docRef = await db.collection("problems").add({
          question: problem.question,
          solution: problem.solution,
          metadata: problem.metadata,
          createdBy: uid,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {problemId: docRef.id, problem};
      })
    );

    return {
      problems: results,
      curriculum: curriculum ?? undefined,
    };
  }
);

export const generateBatch = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  generateBatchFlow
);

// ─── 계산력 일괄 생성 ───

const CalcBatchInputSchema = z.object({
  birthDate: z.string(),
  count: z.number().min(1).max(10).default(5),
  operation: z.enum([
    "addition", "subtraction",
    "multiplication", "division", "mixed",
  ]).default("mixed"),
  gradeLevel: z.number().optional(),
  difficulty: z.number().optional(),
});

const CalcBatchOutputSchema = z.object({
  problems: z.array(z.object({
    problemId: z.string(),
    problem: ProblemOutputSchema,
  })),
});

const generateCalcBatchFlow = ai.defineFlow(
  {
    name: "generateCalcBatch",
    inputSchema: CalcBatchInputSchema,
    outputSchema: CalcBatchOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const age = calculateAge(input.birthDate);
    const gradeLevel = input.gradeLevel ?? ageToGradeLevel(age);
    const diff = input.difficulty ?? Math.min(gradeLevel, 5);
    const difficulty = clampDifficulty(diff);
    const opLabel = operationLabels[input.operation] ?? "혼합 연산";
    const count = input.count;

    const difficultyLabel = [
      "", "매우 쉬운", "쉬운", "보통", "어려운", "매우 어려운",
    ][difficulty];

    const operationGuide = input.operation === "mixed" ?
      "덧셈, 뺄셈, 곱셈, 나눗셈을 골고루 섞어서 출제하세요." :
      `반드시 "${opLabel}" 연산만 사용하세요.`;

    const {output} = await ai.generate({
      prompt: `당신은 한국 초등학교 수학 계산력 훈련 전문 교사입니다.
만 ${age}세 (${gradeLevel}학년) 학생의 계산력을 키우기 위한
${difficultyLabel} ${opLabel} 문제를 **${count}개** 만들어 주세요.

난이도: ${difficulty}/5
${operationGuide}

## 중요: ${count}개의 서로 다른 문제를 만드세요!
- 각 문제는 다른 숫자/패턴을 사용하세요

## 학년별 연산 범위
- 1학년: 한 자리 수 (합 20 이하)
- 2학년: 두 자리 수, 구구단
- 3학년: 세 자리 수, 두 자리x한 자리, 나눗셈 기초
- 4학년: 큰 수, 두 자리x두 자리, 세 자리/한 자리
- 5학년: 분수/소수 사칙연산
- 6학년: 분수/소수 혼합, 복잡한 사칙연산

## 텍스트 규칙
- 특수 유니코드 금지. 한글, 숫자, 기본 기호만
- 곱셈 "x", 나눗셈 "/", 분수 "3/4"
- LaTeX 절대 금지. SVG 불필요.

## 문제 규칙
- 한국어, 객관식(4지선다), type="multiple_choice"
- options에 A,B,C,D, answer는 정답 라벨
- metadata: difficulty=${difficulty},
gradeLevel=${gradeLevel}, topic="${opLabel}", domain="수와 연산"

## 풀이: 단계별 풀이 + 계산 팁 + 핵심 요약`,
      output: {schema: BatchProblemArraySchema},
    });

    if (!output || !output.problems || output.problems.length === 0) {
      throw new Error("일괄 계산 문제 생성에 실패했습니다.");
    }

    const results = await Promise.all(
      output.problems.map(async (problem) => {
        const docRef = await db.collection("problems").add({
          question: problem.question,
          solution: problem.solution,
          metadata: problem.metadata,
          type: "calculation",
          createdBy: uid,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {problemId: docRef.id, problem};
      })
    );

    return {problems: results};
  }
);

export const generateCalcBatch = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  generateCalcBatchFlow
);

// ─── 계산력 연습 문제 생성 (경량 — DB 조회 없음) ───

const CalcInputSchema = z.object({
  birthDate: z.string().describe("사용자 생년월일 (YYYY-MM-DD)"),
  operation: z.enum([
    "addition", "subtraction",
    "multiplication", "division", "mixed",
  ]).default("mixed").describe("연산 종류"),
  gradeLevel: z.number().optional()
    .describe("사용자가 선택한 학년 (없으면 birthDate에서 계산)"),
  difficulty: z.number().optional()
    .describe("난이도 (1~5, 없으면 학년 기준)"),
});

const CalcOutputSchema = z.object({
  problemId: z.string(),
  problem: ProblemOutputSchema,
});

const generateCalcProblemFlow = ai.defineFlow(
  {
    name: "generateCalcProblem",
    inputSchema: CalcInputSchema,
    outputSchema: CalcOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const age = calculateAge(input.birthDate);
    const gradeLevel = input.gradeLevel ?? ageToGradeLevel(age);
    const diff = input.difficulty ?? Math.min(gradeLevel, 5);
    const difficulty = clampDifficulty(diff);
    const opLabel = operationLabels[input.operation] ?? "혼합 연산";

    const difficultyLabel = [
      "", "매우 쉬운", "쉬운", "보통", "어려운", "매우 어려운",
    ][difficulty];

    const operationGuide = input.operation === "mixed" ? `
- 덧셈, 뺄셈, 곱셈, 나눗셈 중 랜덤으로 하나를 선택하여 출제하세요.
` : `
- 반드시 "${opLabel}" 연산만 사용하세요.
`;

    /* eslint-disable max-len */
    const {output} = await ai.generate({
      prompt: `당신은 한국 초등학교 수학 계산력 훈련 전문 교사입니다.
만 ${age}세 (${gradeLevel}학년) 학생의 계산력을 키우기 위한 ${difficultyLabel} ${opLabel} 문제를 하나 만들어 주세요.

난이도: ${difficulty}/5
연산 종류: ${opLabel}
${operationGuide}

## 학년별 연산 범위
- 1학년: 한 자리 수 덧셈/뺄셈 (합 20 이하)
- 2학년: 두 자리 수 덧셈/뺄셈, 구구단 (2~9단)
- 3학년: 세 자리 수 덧셈/뺄셈, 두 자리 x 한 자리, 나눗셈 기초
- 4학년: 큰 수 연산, 두 자리 x 두 자리, 세 자리 / 한 자리
- 5학년: 분수/소수 사칙연산, 혼합 계산
- 6학년: 분수/소수 혼합 계산, 복잡한 사칙연산

## 난이도별 가이드
- 난이도 1: 기본 연산, 받아올림/받아내림 없음
- 난이도 2: 받아올림/받아내림 1회
- 난이도 3: 받아올림/받아내림 여러 번, 두 단계 계산
- 난이도 4: 세 수 이상의 연산, 복합 계산
- 난이도 5: 암산 도전 수준, 큰 수 또는 복합 연산

## 텍스트 작성 규칙 (매우 중요!)
- 특수 유니코드 문자를 절대 사용하지 마세요.
- 한글, 숫자, 기본 영문, 기본 기호만 사용하세요.
- 허용 기호: +, -, =, <, >, (, ), /, *, ., ?, !
- 곱셈은 소문자 "x"를 사용하세요.
- 나눗셈은 "/" 또는 "÷"를 사용하세요.
- 분수는 "3/4" 처럼 슬래시로 표기하세요.
- LaTeX 문법은 절대 사용하지 마세요.

## 문제 출제 규칙
- 문제는 한국어로 작성
- 반드시 객관식(4지선다)으로 출제
- type은 반드시 "multiple_choice"로 설정
- 반드시 options 배열에 A, B, C, D 4개의 선택지를 포함
- answer는 반드시 정답 선택지의 라벨(A, B, C, D 중 하나)로 설정
- metadata.difficulty는 반드시 ${difficulty}로 설정
- metadata.gradeLevel은 반드시 ${gradeLevel}로 설정
- metadata.topic은 "${opLabel}"으로 설정
- metadata.domain은 "수와 연산"으로 설정
- metadata.learningObjective는 이 문제의 계산력 학습 목표를 한 문장으로

## 풀이 과정 (매우 중요!)
풀이 과정(explanation)에 반드시 다음을 포함하세요:

1. **단계별 풀이**: 계산 과정을 한 단계씩 보여주세요
2. **계산 팁**: 이 문제를 더 빠르고 효율적으로 푸는 방법을 알려주세요. 예시:
   - 보수 활용: "8 + 7 = 8 + 2 + 5 = 15 (8에 2를 더해 10을 만들고 나머지 5를 더함)"
   - 자릿수 분해: "23 x 4 = 20 x 4 + 3 x 4 = 80 + 12 = 92"
   - 교환법칙: "3 x 8 을 어려워하면 8 x 3 = 24로 생각"
   - 배수 활용: "25 x 12 = 25 x 4 x 3 = 100 x 3 = 300"
   - 어림 계산: "498 + 203은 약 500 + 200 = 700에 가까움"
   - 역연산 검증: "계산 결과를 역연산으로 확인하는 방법"
3. **핵심 요약**: 이 유형의 계산에서 기억할 핵심 팁 한 줄

풀이 형식:
"[풀이]
(단계별 풀이)

[계산 팁]
(효율적 계산 방법)

[핵심]
(한 줄 요약)"

SVG는 필요하지 않습니다 (question.svg, explanationSvg는 생략).`,
      output: {schema: ProblemOutputSchema},
    });
    /* eslint-enable max-len */

    if (!output) throw new Error("계산 문제 생성에 실패했습니다.");

    // problems 컬렉션에 저장 (임베딩 스킵)
    const docRef = await db.collection("problems").add({
      question: output.question,
      solution: output.solution,
      metadata: output.metadata,
      type: "calculation",
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
    });

    return {problemId: docRef.id, problem: output};
  }
);

export const generateCalcProblem = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  generateCalcProblemFlow
);

// ─── 답안 제출 → users/{uid}/history 에 기록 저장 ───

const SubmitAnswerInputSchema = z.object({
  problemId: z.string().describe("문제 ID (problems 컬렉션)"),
  userAnswer: z.string().describe("사용자가 입력한 답"),
  isCorrect: z.boolean().describe("정답 여부"),
});

const SubmitOutputSchema = z.object({
  historyId: z.string(),
  xpGained: z.number().describe("이번 문제로 획득한 XP"),
  currentStreak: z.number().describe("현재 연속 정답 수"),
  totalXp: z.number().describe("총 XP"),
  level: z.number().describe("현재 레벨"),
});

/**
 * XP로부터 레벨을 계산합니다.
 * @param {number} xp 총 경험치
 * @return {number} 레벨
 */
function calculateLevel(xp: number): number {
  return Math.floor(Math.sqrt(xp / 100)) + 1;
}

const submitAnswerFlow = ai.defineFlow(
  {
    name: "submitAnswer",
    inputSchema: SubmitAnswerInputSchema,
    outputSchema: SubmitOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // 1) 문제 메타데이터 조회 (토픽 추출)
    let topic = "";
    let difficulty = 1;
    try {
      const problemDoc = await db.collection("problems")
        .doc(input.problemId).get();
      if (problemDoc.exists) {
        const pData = problemDoc.data();
        topic = pData?.metadata?.topic ?? "";
        difficulty = pData?.metadata?.difficulty ?? 1;
      }
    } catch {
      // 문제 조회 실패해도 계속 진행
    }

    // 2) 현재 사용자 통계 조회 (스트릭/XP 계산용)
    const userDoc = await db.collection("users")
      .doc(uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const prevStats = userData?.stats ?? {};
    const prevStreak: number = prevStats.currentStreak ?? 0;
    const prevXp: number = prevStats.totalXp ?? 0;
    const prevBestStreak: number = prevStats.bestStreak ?? 0;
    const prevDailyStreak: number =
      prevStats.dailyStreak ?? 0;
    const lastAnswerDate: string =
      prevStats.lastAnswerDate ?? "";

    // 3) 스트릭 계산
    const newStreak = input.isCorrect ? prevStreak + 1 : 0;
    const bestStreak = Math.max(prevBestStreak, newStreak);

    // 4) XP 계산
    let xpGained = 0;
    if (input.isCorrect) {
      xpGained = difficulty * 10; // 기본 XP
      xpGained += newStreak * 5; // 연속 정답 보너스
    } else {
      xpGained = 5; // 참여 보상
    }
    const newTotalXp = prevXp + xpGained;
    const newLevel = calculateLevel(newTotalXp);

    // 5) 일일 스트릭 계산
    const today = new Date().toISOString().split("T")[0];
    const yesterday = new Date(
      Date.now() - 86400000
    ).toISOString().split("T")[0];
    let dailyStreak = prevDailyStreak;
    if (lastAnswerDate !== today) {
      // 오늘 첫 문제
      if (lastAnswerDate === yesterday) {
        dailyStreak = prevDailyStreak + 1;
      } else if (lastAnswerDate === "") {
        dailyStreak = 1;
      } else {
        dailyStreak = 1; // 연속 끊김
      }
    }

    // 6) history 기록 저장
    const historyRef = await db
      .collection("users").doc(uid)
      .collection("history").add({
        problemId: input.problemId,
        userAnswer: input.userAnswer,
        isCorrect: input.isCorrect,
        answeredAt: FieldValue.serverTimestamp(),
      });

    // 7) users/{uid} 통계 업데이트
    await db.collection("users").doc(uid).set({
      stats: {
        totalProblems: FieldValue.increment(1),
        correctProblems: input.isCorrect ?
          FieldValue.increment(1) : FieldValue.increment(0),
        lastPracticeAt: FieldValue.serverTimestamp(),
        currentStreak: newStreak,
        bestStreak,
        totalXp: newTotalXp,
        level: newLevel,
        dailyStreak,
        lastAnswerDate: today,
      },
    }, {merge: true});

    // 8) 토픽 마스터리 업데이트
    if (topic) {
      const topicRef = db.collection("users").doc(uid)
        .collection("topicStats").doc(topic);
      await topicRef.set({
        total: FieldValue.increment(1),
        correct: input.isCorrect ?
          FieldValue.increment(1) : FieldValue.increment(0),
        lastPracticed: FieldValue.serverTimestamp(),
        streak: input.isCorrect ?
          FieldValue.increment(1) : 0,
      }, {merge: true});
    }

    return {
      historyId: historyRef.id,
      xpGained,
      currentStreak: newStreak,
      totalXp: newTotalXp,
      level: newLevel,
    };
  }
);

export const submitAnswer = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  submitAnswerFlow
);

// ─── 벡터 유사도로 비슷한 문제 검색 ───

const FindSimilarInputSchema = z.object({
  problemText: z.string().describe("기준 문제 텍스트"),
  limit: z.number().default(5).describe("검색 결과 수"),
});

const findSimilarFlow = ai.defineFlow(
  {
    name: "findSimilar",
    inputSchema: FindSimilarInputSchema,
    outputSchema: z.object({
      problems: z.array(z.object({
        id: z.string(),
        question: QuestionSchema,
        metadata: MetadataSchema,
        similarity: z.number(),
      })),
    }),
  },
  async ({problemText, limit}) => {
    const embedResult = await ai.embed({
      embedder: googleAI.embedder("text-embedding-005"),
      content: problemText,
    });
    const queryEmbedding = embedResult[0]?.embedding ?? [];

    const snapshot = await db.collection("problems")
      .findNearest({
        vectorField: "embedding",
        queryVector: queryEmbedding,
        limit,
        distanceMeasure: "COSINE",
      })
      .get();

    const problems = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        question: data.question,
        metadata: data.metadata,
        similarity: data._distance ?? 0,
      };
    });

    return {problems};
  }
);

export const findSimilar = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  findSimilarFlow
);

// ─── 문제에 대해 AI와 대화 ───

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]).describe("메시지 역할"),
  content: z.string().describe("메시지 내용"),
});

const ChatInputSchema = z.object({
  problemId: z.string().describe("문제 ID (problems 컬렉션)"),
  messages: z.array(ChatMessageSchema).describe("이전 대화 이력"),
  question: z.string().describe("사용자의 질문"),
});

const ChatOutputSchema = z.object({
  answer: z.string().describe("AI 튜터의 답변"),
});

const chatAboutProblemFlow = ai.defineFlow(
  {
    name: "chatAboutProblem",
    inputSchema: ChatInputSchema,
    outputSchema: ChatOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // Firestore에서 문제 데이터 가져오기
    const problemDoc = await db.collection("problems")
      .doc(input.problemId).get();
    if (!problemDoc.exists) {
      throw new Error("문제를 찾을 수 없습니다.");
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const problem = problemDoc.data()!;

    // 문제 컨텍스트 구성
    const problemContext = [
      `[문제] ${problem.question.text}`,
      problem.question.type === "multiple_choice" &&
        problem.question.options ?
        `[선택지]\n${problem.question.options.map(
          (o: {label: string; text: string}) =>
            `${o.label}. ${o.text}`
        ).join("\n")}` :
        "",
      `[정답] ${problem.solution.answer}`,
      `[풀이] ${problem.solution.explanation}`,
      `[주제] ${problem.metadata.topic}`,
      `[학년] ${problem.metadata.gradeLevel}학년` +
        ` | [난이도] ${problem.metadata.difficulty}/5`,
    ].filter(Boolean).join("\n");

    // 이전 대화 이력을 Gemini 메시지 형식으로 변환
    const history = input.messages.map((msg) => ({
      role: msg.role === "user" ? ("user" as const) : ("model" as const),
      content: [{text: msg.content}],
    }));

    const {text} = await ai.generate({
      system: `당신은 친절한 초등학교 수학 튜터입니다.
학생이 푼 수학 문제에 대해 질문하고 있습니다.

아래는 학생이 푼 문제의 정보입니다:
${problemContext}

규칙:
- 학생의 눈높이에 맞게 쉽고 친절하게 설명하세요.
- 수학 개념을 단계별로 풀어서 설명하세요.
- 학생이 스스로 이해할 수 있도록 힌트를 주며 이끌어주세요.
- 한국어로 답변하세요.
- 답변은 간결하되 충분히 설명적이어야 합니다.`,
      messages: [
        ...history,
        {role: "user" as const, content: [{text: input.question}]},
      ],
    });

    return {answer: text ?? "답변을 생성하지 못했습니다."};
  }
);

export const chatAboutProblem = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  chatAboutProblemFlow
);

// ─── 매일 시험 ───

/**
 * KST(UTC+9) 기준 오늘 날짜를 반환합니다.
 * @return {string} YYYY-MM-DD 형식
 */
function getKstToday(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  return kst.toISOString().split("T")[0];
}

const GetDailyTestInputSchema = z.object({
  birthDate: z.string().describe("사용자 생년월일 (YYYY-MM-DD)"),
});

const DailyTestAnswerSchema = z.object({
  problemIndex: z.number(),
  userAnswer: z.string(),
  isCorrect: z.boolean(),
  correctAnswer: z.string(),
});

const DailyTestResultSchema = z.object({
  rawScore: z.number(),
  correctCount: z.number(),
  standardScore: z.number(),
  percentile: z.number(),
  totalAttempts: z.number(),
});

const GetDailyTestOutputSchema = z.object({
  testId: z.string(),
  date: z.string(),
  grade: z.number(),
  problems: z.array(ProblemOutputSchema),
  alreadyCompleted: z.boolean(),
  previousResult: DailyTestResultSchema.optional(),
});

const getDailyTestFlow = ai.defineFlow(
  {
    name: "getDailyTest",
    inputSchema: GetDailyTestInputSchema,
    outputSchema: GetDailyTestOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const age = calculateAge(input.birthDate);
    const grade = ageToGradeLevel(age);
    const today = getKstToday();
    const testId = `${today}_grade${grade}`;

    const testRef = db.collection("dailyTests").doc(testId);
    const resultRef = testRef.collection("results").doc(uid);

    // 1) 기존 테스트 + 사용자 결과 확인
    const [testSnap, resultSnap] = await Promise.all([
      testRef.get(),
      resultRef.get(),
    ]);

    if (testSnap.exists) {
      const testData = testSnap.data()!;
      const problems = testData.problems ?? [];

      if (resultSnap.exists) {
        // 이미 응시 완료 — 통계 재계산하여 반환
        const resultData = resultSnap.data()!;
        const stats = testData.stats ?? {
          totalAttempts: 0, scoreSum: 0, scoreSqSum: 0,
        };
        const prev = computeScores(
          resultData.rawScore, stats, testRef
        );
        return {
          testId, date: today, grade, problems,
          alreadyCompleted: true,
          previousResult: await prev,
        };
      }

      return {
        testId, date: today, grade, problems,
        alreadyCompleted: false,
      };
    }

    // 2) 테스트가 없으면 생성 — 문제를 먼저 생성 (transaction 밖)
    const difficulties = [1, 2, 2, 3, 3, 3, 4, 4, 4, 5];
    const domains = [
      "수와 연산", "도형과 측정", "자료와 가능성", "변화와 관계",
    ];
    const difficultyLabels = [
      "", "매우 쉬운", "쉬운", "보통", "어려운", "매우 어려운",
    ];

    // 10문제 생성 (순차 — Gemini API 병렬은 쿼터 초과 위험)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const problems: any[] = [];
    for (let i = 0; i < 10; i++) {
      const diff = difficulties[i];
      const domainHint = domains[i % domains.length];
      const diffLabel = difficultyLabels[diff];

      const {output} = await ai.generate({
        prompt: `당신은 한국 초등학교 수학 교사입니다.
${grade}학년 학생을 위한 일일 시험 문제를 하나 만들어 주세요.

난이도: ${diff}/5 (${diffLabel})
수학 영역: ${domainHint}

## 텍스트 작성 규칙
- 특수 유니코드 문자를 절대 사용하지 마세요.
- 한글, 숫자, 기본 영문, 기본 기호만 사용하세요.
- 곱셈은 소문자 "x", 나눗셈은 "/", 분수는 "3/4" 형식.
- LaTeX 문법은 절대 사용하지 마세요.

## 출제 규칙
- 한국어로 작성
- 반드시 객관식(4지선다): type = "multiple_choice"
- options 배열에 A, B, C, D 4개의 선택지
- answer는 정답 라벨(A~D)
- metadata.difficulty = ${diff}
- metadata.gradeLevel = ${grade}
- metadata.domain = "${domainHint}"
- metadata.learningObjective를 한 문장으로 작성

## SVG 규칙
도형/그래프 문제인 경우만 question.svg에 SVG를 포함하세요.
- viewBox="0 0 300 200"
- stroke="#6C63FF", fill="#E8E7F0"
- <text>에 font-family="'Noto Sans KR', sans-serif"

## 풀이 과정
학생이 이해할 수 있도록 단계별로 설명하세요.`,
        output: {schema: ProblemOutputSchema},
      });

      if (output) {
        problems.push(output);
      }
    }

    if (problems.length === 0) {
      throw new Error("시험 문제 생성에 실패했습니다.");
    }

    // 3) Transaction으로 저장 (중복 방지)
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(testRef);
      if (snap.exists) return; // 다른 요청이 먼저 생성함

      txn.set(testRef, {
        date: today,
        grade,
        createdAt: FieldValue.serverTimestamp(),
        problems,
        stats: {totalAttempts: 0, scoreSum: 0, scoreSqSum: 0},
      });
    });

    // Transaction 후 최신 데이터 반환 (다른 요청이 먼저 생성했을 수도 있음)
    const freshSnap = await testRef.get();
    return {
      testId, date: today, grade,
      problems: freshSnap.data()?.problems ?? problems,
      alreadyCompleted: false,
    };
  }
);

/**
 * 표준점수와 상위 %를 계산합니다.
 * @param {number} rawScore - 원점수
 * @param {object} stats - 통계 데이터
 * @param {FirebaseFirestore.DocumentReference} testRef - 테스트 참조
 * @return {Promise<object>} 점수 결과
 */
async function computeScores(
  rawScore: number,
  stats: {totalAttempts: number; scoreSum: number; scoreSqSum: number},
  testRef: FirebaseFirestore.DocumentReference,
): Promise<{
  rawScore: number;
  correctCount: number;
  standardScore: number;
  percentile: number;
  totalAttempts: number;
}> {
  const n = stats.totalAttempts;
  const mean = n > 0 ? stats.scoreSum / n : 0;
  const varianceNum = stats.scoreSqSum -
    (stats.scoreSum ** 2 / n);
  const variance = n > 1 ?
    varianceNum / (n - 1) :
    0;
  const stddev = Math.sqrt(Math.max(0, variance));

  // T-score (평균 50, 표준편차 10)
  const tScore = n >= 5 && stddev > 0 ?
    50 + 10 * (rawScore - mean) / stddev :
    -1; // N<5 이면 통계 미준비

  // 상위 %
  let percentile = -1;
  if (n >= 2) {
    const allResults = await testRef.collection("results").get();
    const scores = allResults.docs.map(
      (d) => (d.data().rawScore as number)
    );
    const below = scores.filter((s) => s < rawScore).length;
    const same = scores.filter((s) => s === rawScore).length;
    const rank = (below + 0.5 * same) / scores.length;
    percentile = Math.round((1 - rank) * 1000) / 10; // 상위 X%
  }

  return {
    rawScore,
    correctCount: Math.round(rawScore / 10),
    standardScore: tScore >= 0 ? Math.round(tScore * 10) / 10 : -1,
    percentile,
    totalAttempts: n,
  };
}

export const getDailyTest = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  getDailyTestFlow
);

// ─── 시험 답안 제출 ───

const SubmitDailyTestInputSchema = z.object({
  testId: z.string(),
  answers: z.array(z.object({
    problemIndex: z.number(),
    userAnswer: z.string(),
  })),
  timeSpentSeconds: z.number(),
});

const SubmitDailyTestOutputSchema = z.object({
  rawScore: z.number(),
  correctCount: z.number(),
  standardScore: z.number(),
  percentile: z.number(),
  totalAttempts: z.number(),
  answers: z.array(DailyTestAnswerSchema),
});

const submitDailyTestFlow = ai.defineFlow(
  {
    name: "submitDailyTest",
    inputSchema: SubmitDailyTestInputSchema,
    outputSchema: SubmitDailyTestOutputSchema,
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const testRef = db.collection("dailyTests").doc(input.testId);
    const resultRef = testRef.collection("results").doc(uid);

    // 1) 중복 제출 확인
    const existing = await resultRef.get();
    if (existing.exists) {
      throw new Error("이미 제출한 시험입니다.");
    }

    // 2) 테스트 문서 조회
    const testSnap = await testRef.get();
    if (!testSnap.exists) {
      throw new Error("시험을 찾을 수 없습니다.");
    }
    const testData = testSnap.data()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const problems = testData.problems as any[];

    // 3) 채점
    const gradedAnswers = input.answers.map((a) => {
      const problem = problems[a.problemIndex];
      if (!problem) {
        return {
          problemIndex: a.problemIndex,
          userAnswer: a.userAnswer,
          isCorrect: false,
          correctAnswer: "",
        };
      }
      const correctAnswer = problem.solution?.answer ?? "";
      const isCorrect = a.userAnswer === correctAnswer;
      return {
        problemIndex: a.problemIndex,
        userAnswer: a.userAnswer,
        isCorrect,
        correctAnswer,
      };
    });

    const correctCount = gradedAnswers.filter((a) => a.isCorrect).length;
    const rawScore = Math.round((correctCount / problems.length) * 100);

    // 4) 결과 저장 + 통계 업데이트 (transaction)
    await db.runTransaction(async (txn) => {
      const freshTest = await txn.get(testRef);
      const stats = freshTest.data()?.stats ?? {
        totalAttempts: 0, scoreSum: 0, scoreSqSum: 0,
      };

      txn.update(testRef, {
        "stats.totalAttempts": stats.totalAttempts + 1,
        "stats.scoreSum": stats.scoreSum + rawScore,
        "stats.scoreSqSum": stats.scoreSqSum + (rawScore * rawScore),
      });

      txn.set(resultRef, {
        uid,
        rawScore,
        correctCount,
        answers: gradedAnswers,
        completedAt: FieldValue.serverTimestamp(),
        timeSpentSeconds: input.timeSpentSeconds,
      });
    });

    // 5) 표준점수 + 상위 % 계산 (transaction 후)
    const freshTest = await testRef.get();
    const stats = freshTest.data()?.stats ?? {
      totalAttempts: 0, scoreSum: 0, scoreSqSum: 0,
    };
    const scores = await computeScores(rawScore, stats, testRef);

    return {
      ...scores,
      answers: gradedAnswers,
    };
  }
);

export const submitDailyTest = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  submitDailyTestFlow
);

// ─── 친구 기능 ───

/**
 * 8자리 랜덤 영숫자 초대 코드를 생성합니다.
 * @return {string} 초대 코드
 */
function generateRandomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const generateInviteCodeFlow = ai.defineFlow(
  {
    name: "generateInviteCode",
    inputSchema: z.object({}),
    outputSchema: z.object({
      inviteCode: z.string(),
      inviteUrl: z.string(),
    }),
  },
  async (_input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // 기존 코드가 있는지 확인
    const userDoc = await db.collection("users").doc(uid).get();
    const existingCode = userDoc.data()?.inviteCode;

    if (existingCode) {
      return {
        inviteCode: existingCode,
        inviteUrl: `https://mathology-b8e3d.web.app/invite/${existingCode}`,
      };
    }

    // 새 코드 생성 (충돌 방지 루프)
    let code: string;
    let attempts = 0;
    do {
      code = generateRandomCode();
      const existing = await db.collection("inviteCodes").doc(code).get();
      if (!existing.exists) break;
      attempts++;
    } while (attempts < 5);

    // 코드 저장
    await Promise.all([
      db.collection("inviteCodes").doc(code).set({
        uid,
        createdAt: FieldValue.serverTimestamp(),
      }),
      db.collection("users").doc(uid).update({
        inviteCode: code,
      }),
    ]);

    return {
      inviteCode: code,
      inviteUrl: `https://mathology-b8e3d.web.app/invite/${code}`,
    };
  }
);

export const generateInviteCode = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  generateInviteCodeFlow
);

const acceptInviteFlow = ai.defineFlow(
  {
    name: "acceptInvite",
    inputSchema: z.object({
      inviteCode: z.string(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      friendUid: z.string(),
      friendDisplayName: z.string(),
    }),
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // 1) 초대 코드 조회
    const codeDoc = await db.collection("inviteCodes")
      .doc(input.inviteCode).get();
    if (!codeDoc.exists) {
      throw new Error("유효하지 않은 초대 코드입니다.");
    }

    const inviterUid = codeDoc.data()?.uid as string;

    // 2) 자기 자신 초대 방지
    if (inviterUid === uid) {
      throw new Error("자기 자신을 초대할 수 없습니다.");
    }

    // 3) 이미 친구인지 확인
    const [smaller, larger] = [uid, inviterUid].sort();
    const friendshipId = `${smaller}_${larger}`;
    const existingFriendship = await db.collection("friendships")
      .doc(friendshipId).get();
    if (existingFriendship.exists) {
      throw new Error("이미 친구입니다.");
    }

    // 4) 양쪽 사용자 정보 조회
    const [myDoc, inviterDoc] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(inviterUid).get(),
    ]);

    const myName = myDoc.data()?.displayName ?? "사용자";
    const inviterName = inviterDoc.data()?.displayName ?? "사용자";

    // 5) 트랜잭션으로 친구 관계 생성
    await db.runTransaction(async (txn) => {
      txn.set(db.collection("friendships").doc(friendshipId), {
        users: [smaller, larger],
        createdAt: FieldValue.serverTimestamp(),
      });

      txn.set(
        db.collection("users").doc(uid)
          .collection("friends").doc(inviterUid),
        {
          displayName: inviterName,
          addedAt: FieldValue.serverTimestamp(),
        }
      );

      txn.set(
        db.collection("users").doc(inviterUid)
          .collection("friends").doc(uid),
        {
          displayName: myName,
          addedAt: FieldValue.serverTimestamp(),
        }
      );
    });

    return {
      success: true,
      friendUid: inviterUid,
      friendDisplayName: inviterName,
    };
  }
);

export const acceptInvite = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  acceptInviteFlow
);

const getFriendsListFlow = ai.defineFlow(
  {
    name: "getFriendsList",
    inputSchema: z.object({}),
    outputSchema: z.object({
      friends: z.array(z.object({
        uid: z.string(),
        displayName: z.string(),
        level: z.number(),
        totalXp: z.number(),
        currentStreak: z.number(),
        dailyStreak: z.number(),
        totalProblems: z.number(),
        correctProblems: z.number(),
      })),
    }),
  },
  async (_input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // 친구 목록 조회
    const friendsSnap = await db.collection("users").doc(uid)
      .collection("friends").get();

    if (friendsSnap.empty) {
      return {friends: []};
    }

    // 각 친구의 유저 정보 배치 조회
    const friendUids = friendsSnap.docs.map((doc) => doc.id);
    const userDocs = await Promise.all(
      friendUids.map((fUid) => db.collection("users").doc(fUid).get())
    );

    const friends = userDocs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const data = doc.data()!;
        const stats = data.stats ?? {};
        return {
          uid: doc.id,
          displayName: data.displayName ?? "사용자",
          level: stats.level ?? 1,
          totalXp: stats.totalXp ?? 0,
          currentStreak: stats.currentStreak ?? 0,
          dailyStreak: stats.dailyStreak ?? 0,
          totalProblems: stats.totalProblems ?? 0,
          correctProblems: stats.correctProblems ?? 0,
        };
      });

    // 레벨 높은 순으로 정렬
    friends.sort((a, b) => b.level - a.level || b.totalXp - a.totalXp);

    return {friends};
  }
);

export const getFriendsList = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  getFriendsListFlow
);

const getFriendsDailyTestResultsFlow = ai.defineFlow(
  {
    name: "getFriendsDailyTestResults",
    inputSchema: z.object({
      testId: z.string(),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        uid: z.string(),
        displayName: z.string(),
        rawScore: z.number(),
        correctCount: z.number(),
        standardScore: z.number(),
        percentile: z.number(),
        isMe: z.boolean(),
      })),
    }),
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    // 1) 친구 목록 + 내 정보 조회
    const [friendsSnap, myDoc] = await Promise.all([
      db.collection("users").doc(uid).collection("friends").get(),
      db.collection("users").doc(uid).get(),
    ]);

    const allUids = [uid, ...friendsSnap.docs.map((doc) => doc.id)];

    // 2) 각 사용자의 시험 결과 조회
    const resultDocs = await Promise.all(
      allUids.map((u) =>
        db.collection("dailyTests").doc(input.testId)
          .collection("results").doc(u).get()
      )
    );

    // 3) 이름 매핑 준비
    const nameMap: Record<string, string> = {};
    nameMap[uid] = myDoc.data()?.displayName ?? "나";
    for (const doc of friendsSnap.docs) {
      nameMap[doc.id] = doc.data()?.displayName ?? "사용자";
    }

    // 4) 결과가 있는 사용자만 포함
    const results = resultDocs
      .filter((doc) => doc.exists)
      .map((doc) => {
        const data = doc.data()!;
        const resultUid = doc.id;
        return {
          uid: resultUid,
          displayName: nameMap[resultUid] ?? "사용자",
          rawScore: data.rawScore ?? 0,
          correctCount: data.correctCount ?? 0,
          standardScore: data.standardScore ?? -1,
          percentile: data.percentile ?? -1,
          isMe: resultUid === uid,
        };
      });

    // 점수 높은 순으로 정렬
    results.sort((a, b) => b.rawScore - a.rawScore);

    return {results};
  }
);

export const getFriendsDailyTestResults = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  getFriendsDailyTestResultsFlow
);

const removeFriendFlow = ai.defineFlow(
  {
    name: "removeFriend",
    inputSchema: z.object({
      friendUid: z.string(),
    }),
    outputSchema: z.object({
      success: z.boolean(),
    }),
  },
  async (input, {context}) => {
    const uid = context?.auth?.uid;
    if (!uid) throw new Error("인증이 필요합니다.");

    const [smaller, larger] = [uid, input.friendUid].sort();
    const friendshipId = `${smaller}_${larger}`;

    await db.runTransaction(async (txn) => {
      txn.delete(db.collection("friendships").doc(friendshipId));
      txn.delete(
        db.collection("users").doc(uid)
          .collection("friends").doc(input.friendUid)
      );
      txn.delete(
        db.collection("users").doc(input.friendUid)
          .collection("friends").doc(uid)
      );
    });

    return {success: true};
  }
);

export const removeFriend = onCallGenkit(
  {
    authPolicy: (auth) => {
      if (!auth) throw new Error("인증이 필요합니다.");
      return true;
    },
  },
  removeFriendFlow
);

// ─── 매일 블로그 문제 자동 생성 (Scheduled Function) ───

/**
 * 매일 오전 6시(KST, UTC 21:00) 실행되어 블로그용 문제 초안을 생성합니다.
 * 관리자가 설정한 dailyProblemCount 만큼 Firestore의 blogDrafts 컬렉션에 저장합니다.
 * 이후 관리자가 /admin 페이지에서 검토 후 발행합니다.
 */
export const dailyBlogGenerate = onSchedule(
  {
    schedule: "0 21 * * *", // UTC 21:00 = KST 06:00
    timeZone: "Asia/Seoul",
    retryCount: 1,
  },
  async () => {
    // 설정 조회 (Firestore에 저장된 사이트 설정)
    const settingsDoc = await db.collection("siteSettings")
      .doc("blog").get();
    const settings = settingsDoc.exists ? settingsDoc.data() : {};
    const count: number = settings?.dailyProblemCount ?? 3;
    const enabled: boolean = settings?.autoGenerateEnabled ?? false;

    if (!enabled) {
      console.log("자동 생성이 비활성화되어 있습니다. 건너뜁니다.");
      return;
    }

    const today = getKstToday();
    const topics = [
      "지수와 로그", "수열", "미분", "적분",
      "확률과 통계", "삼각함수", "벡터", "이차곡선",
    ];
    const difficulties = [2, 3, 3, 4, 4, 5];

    console.log(`[${today}] 블로그 문제 ${count}개 생성 시작`);

    for (let i = 0; i < count; i++) {
      const topic = topics[Math.floor(Math.random() * topics.length)];
      const difficulty = difficulties[
        Math.floor(Math.random() * difficulties.length)
      ];

      try {
        const {output} = await ai.generate({
          prompt: `당신은 수능 수학 전문 교사입니다.
고등학생을 위한 "${topic}" 관련 수학 문제 풀이 블로그 글을 작성해 주세요.

난이도: ${difficulty}/5
주제: ${topic}

다음 형식의 마크다운으로 작성하세요:

## 문제

(LaTeX 수식을 포함한 문제. $$ $$ 블록 수식과 $ $ 인라인 수식을 사용하세요)

(1) 선택지1  (2) 선택지2  (3) 선택지3  (4) 선택지4  (5) 선택지5

---

## 풀이

### 핵심 개념

(이 문제를 풀기 위한 핵심 수학 개념 설명)

### 단계별 풀이

**1단계:** (첫 번째 풀이 단계 - LaTeX 수식 포함)

**2단계:** (두 번째 풀이 단계)

(필요한 만큼 단계 추가)

---

## 핵심 정리

> (핵심 정리 내용을 인용 블록으로)

이 문제에서 사용한 핵심 전략:
1. (전략 1)
2. (전략 2)

규칙:
- 수식은 반드시 LaTeX 형식 ($...$, $$...$$)을 사용하세요
- 한국어로 작성하세요
- 풀이는 고등학생이 이해할 수 있게 상세하게 작성하세요
- 정답은 1~5 중 하나의 숫자로 제공하세요`,
          output: {
            schema: z.object({
              title: z.string().describe("문제 제목 (주제 - 핵심 개념)"),
              description: z.string().describe("문제 설명 (1줄)"),
              content: z.string().describe("마크다운 본문 전체"),
              answer: z.string().describe("정답 (숫자)"),
              tags: z.array(z.string()).describe("관련 태그"),
            }),
          },
        });

        if (output) {
          await db.collection("blogDrafts").add({
            slug: `csat-${today}-${(i + 1)
              .toString().padStart(2, "0")}`,
            title: output.title,
            description: output.description,
            content: output.content,
            answer: output.answer,
            tags: output.tags,
            topic,
            difficulty,
            date: today,
            status: "draft",
            createdAt: FieldValue.serverTimestamp(),
          });
          console.log(`문제 ${i + 1}/${count} 생성 완료: ${output.title}`);
        }
      } catch (e) {
        console.error(`문제 ${i + 1}/${count} 생성 실패:`, e);
      }
    }

    console.log(`[${today}] 블로그 문제 생성 완료`);
  }
);
