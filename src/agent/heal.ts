// Self-healing: when a model call fails, work out WHY (a human cause + fix) and, when
// possible, REMEDIATE automatically (start the local server, pull a missing model, relocate
// Ollama's model store off a non-ASCII path) and retry — so a run drives to the goal instead
// of dumping a raw 500 on the user.
import { ensureServer, ollamaCmd, run, fixWindowsModelsPath, restartOllama } from "../setup/localllm.js";

export interface Diagnosis {
  cause: string; // why it failed (human, Korean-facing)
  fix: string; // how it's fixed / what to do
  action?: "start-server" | "pull-model" | "fix-ollama-path" | "backoff";
  model?: string; // local model id (no prefix) for pull/path actions
  retryable: boolean; // worth retrying after remediation
}

/** Classify a failure message into a cause + (optionally) an auto-remediation action. */
export function diagnose(message: string, modelId?: string): Diagnosis | null {
  const m = (message || "").toLowerCase();
  const isLocal = !!modelId && modelId.startsWith("local/");
  const localId = isLocal ? modelId!.slice("local/".length) : undefined;

  if (/error loading model|failed to load model|llama_model_loader|llama-server process has terminated|llama runner process has terminated/.test(m)) {
    return {
      cause: "Ollama가 모델을 로드하지 못했습니다 (한글/비ASCII 사용자명 경로 문제일 가능성이 큼)",
      fix: "모델 저장 경로를 ASCII(OLLAMA_MODELS)로 옮기고 Ollama 재시작 후 모델을 다시 받습니다",
      action: "fix-ollama-path",
      model: localId,
      retryable: true,
    };
  }
  if ((isLocal || m.includes("11434")) && /econnrefused|fetch failed|connection refused|upstream unreachable|socket hang up|network|enotfound/.test(m)) {
    return { cause: "로컬 LLM 서버(Ollama)에 연결할 수 없습니다", fix: "Ollama 서버를 시작합니다", action: "start-server", retryable: true };
  }
  if (localId && /not found|no such model|try pulling|pull it first|model '[^']+' not found/.test(m)) {
    return { cause: `로컬 모델 ${localId} 이(가) 설치돼 있지 않습니다`, fix: "모델을 내려받습니다", action: "pull-model", model: localId, retryable: true };
  }
  if (/\b429\b|rate.?limit|too many requests|quota/.test(m)) {
    return { cause: "요청이 많아 일시적으로 제한됨(429)", fix: "잠시 후 자동 재시도", action: "backoff", retryable: true };
  }
  if (/no api key|api key set|run `poly login`|\b401\b|unauthorized/.test(m)) {
    return { cause: "OpenRouter API 키가 없거나 잘못되었습니다", fix: "로그인 화면에서 키를 넣거나 로컬 모델을 설치하세요", retryable: false };
  }
  if (/context length|maximum context|too long|reduce the length|exceeds the/.test(m)) {
    return { cause: "입력이 모델의 컨텍스트 한도를 초과했습니다", fix: "더 큰 컨텍스트 모델로 바꾸거나 입력을 줄이세요", retryable: false };
  }
  if (/insufficient (memory|vram|ram)|out of memory|oom|cudamalloc/.test(m)) {
    return { cause: "모델을 올릴 메모리가 부족합니다", fix: "더 작은 모델을 쓰세요 (모델 탭에서 작은 모델 설치)", retryable: false };
  }
  return null;
}

/** Apply an auto-remediation. Returns true if it likely fixed the cause (worth a retry). */
export async function remediate(d: Diagnosis, baseUrl = "http://localhost:11434"): Promise<boolean> {
  try {
    switch (d.action) {
      case "start-server":
        return await ensureServer(baseUrl);
      case "pull-model":
        if (!d.model) return false;
        fixWindowsModelsPath();
        return await run(ollamaCmd(), ["pull", d.model]);
      case "fix-ollama-path": {
        fixWindowsModelsPath(); // relocate model store to an ASCII path + persist
        await restartOllama(baseUrl); // restart so the server uses the new path
        if (d.model) await run(ollamaCmd(), ["pull", d.model]); // re-fetch into the ASCII path
        return true;
      }
      case "backoff":
        await new Promise((r) => setTimeout(r, 4000));
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}
