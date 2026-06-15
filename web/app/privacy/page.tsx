export const metadata = { title: "polyrun 개인정보처리방침" };

const S: React.CSSProperties = { maxWidth: 760, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui,sans-serif", color: "#2a211e", lineHeight: 1.75 };
const H: React.CSSProperties = { fontFamily: "Georgia,serif", color: "#6e2436", marginTop: 28 };

export default function Privacy() {
  return (
    <main style={S}>
      <h1 style={{ ...H, marginTop: 0 }}>polyrun 개인정보처리방침</h1>
      <p style={{ color: "#8a7d6e" }}>최종 업데이트: 2026-06-15</p>
      <p>본 방침은 polyrun이 수집·이용하는 정보와 그 처리에 대해 설명합니다.</p>

      <h2 style={H}>1. 수집하는 정보</h2>
      <ul>
        <li><b>계정 정보</b>: Google 로그인 시 이메일 주소, 표시 이름, 계정 고유 식별자(uid).</li>
        <li><b>진단(오류) 데이터</b> — 동의한 경우, 오류 발생 시에만 수집: 오류 메시지, 스택 트레이스, 앱 버전, 운영체제/아키텍처, 계정 식별자, 오류 발생 맥락(예: 단계 유형).</li>
      </ul>

      <h2 style={H}>2. 수집하지 않는 정보</h2>
      <p>작업 중인 파일의 내용, 프롬프트 본문, API 키(OpenRouter 키 등), 비밀번호는 진단 데이터로 전송되지 않습니다. API 키는 사용자의 컴퓨터에만 저장됩니다.</p>

      <h2 style={H}>3. 이용 목적</h2>
      <p>수집한 정보는 (1) 로그인·서비스 제공, (2) 오류 진단 및 제품 개선·수정 목적으로만 사용합니다. 광고·판매 목적의 제3자 제공은 하지 않습니다.</p>

      <h2 style={H}>4. 저장 및 보관</h2>
      <p>진단 데이터는 운영자가 관리하는 Google Cloud(Cloud SQL, 리전: us-east4)에 저장됩니다. 인증은 Firebase Authentication을 사용합니다. 데이터는 문제 해결에 필요한 기간 동안 보관하며, 이후 삭제하거나 비식별화합니다.</p>

      <h2 style={H}>5. 제3자 처리자</h2>
      <p>Google(Firebase Authentication, Google Cloud), 그리고 사용자가 선택해 사용하는 LLM 제공자(예: OpenRouter)·로컬 런타임(Ollama 등). 각 제공자에는 해당 서비스 이용에 필요한 범위의 데이터만 전달됩니다.</p>

      <h2 style={H}>6. 동의 및 선택권</h2>
      <p>진단 데이터 전송은 최초 실행 시 동의를 받으며, 앱 설정에서 언제든 끌 수 있습니다(끄면 오류 데이터가 전송되지 않습니다). 계정·데이터 삭제를 원하면 아래 연락처로 요청할 수 있습니다.</p>

      <h2 style={H}>7. 이용자 권리</h2>
      <p>관련 법령(GDPR, 대한민국 개인정보 보호법 등)에 따라 본인 정보에 대한 열람·정정·삭제·처리정지를 요청할 수 있습니다.</p>

      <h2 style={H}>8. 문의</h2>
      <p>개인정보 관련 문의: psychiatristlee@gmail.com</p>
      <p style={{ color: "#b6a892", fontSize: 13, marginTop: 30 }}>
        본 문서는 일반적인 템플릿이며 법률 자문이 아닙니다. 실제 서비스 운영 시 관할 법률에 맞춰 변호사의 검토를 받으시기 바랍니다.
      </p>
    </main>
  );
}
