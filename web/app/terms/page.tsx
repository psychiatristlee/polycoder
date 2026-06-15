export const metadata = { title: "polyrun 서비스 약관" };

const S: React.CSSProperties = { maxWidth: 760, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui,sans-serif", color: "#2a211e", lineHeight: 1.75 };
const H: React.CSSProperties = { fontFamily: "Georgia,serif", color: "#6e2436", marginTop: 28 };

export default function Terms() {
  return (
    <main style={S}>
      <h1 style={{ ...H, marginTop: 0 }}>polyrun 서비스 약관</h1>
      <p style={{ color: "#8a7d6e" }}>최종 업데이트: 2026-06-15</p>
      <p>본 약관은 polyrun(이하 “서비스”)의 이용에 적용됩니다. 서비스를 사용함으로써 본 약관에 동의하는 것으로 간주됩니다.</p>

      <h2 style={H}>1. 서비스 개요</h2>
      <p>polyrun은 로컬 또는 원격 LLM을 이용해 코드를 생성·편집하고 명령을 실행하는 데스크톱 도구입니다. 서비스는 사용자의 컴퓨터에서 파일을 읽고 쓰며 명령을 실행할 수 있습니다.</p>

      <h2 style={H}>2. 계정 및 로그인</h2>
      <p>서비스 이용을 위해 Google 계정 로그인이 필요합니다. 로그인 시 이메일과 계정 고유 식별자가 사용됩니다. 계정 보안 및 본인 계정으로 이루어진 활동에 대한 책임은 사용자에게 있습니다.</p>

      <h2 style={H}>3. 사용자의 책임</h2>
      <ul>
        <li>서비스가 생성한 코드와 명령 실행 결과를 사용자가 검토·검증하고, 그 사용에 대한 책임을 집니다.</li>
        <li>불법적·악의적 목적, 타인의 권리 침해, 서비스나 제3자 시스템에 대한 무단 공격·우회에 사용하지 않습니다.</li>
        <li>OpenRouter 등 제3자 모델·서비스 이용 시 해당 제공자의 약관을 준수합니다.</li>
      </ul>

      <h2 style={H}>4. 진단 데이터</h2>
      <p>오류 발생 시 진단 데이터가 전송될 수 있습니다(동의한 경우). 자세한 내용은 <a href="/privacy" style={{ color: "#a9863f" }}>개인정보처리방침</a>을 참고하세요. 동의는 설정에서 언제든 철회할 수 있습니다.</p>

      <h2 style={H}>5. 보증의 부인 (AS-IS)</h2>
      <p>서비스는 “있는 그대로(AS-IS)” 및 “이용 가능한 범위 내(AS-AVAILABLE)”로 제공되며, 상품성·특정 목적 적합성·비침해성 등 명시적·묵시적 보증을 하지 않습니다. LLM이 생성한 결과의 정확성·안전성을 보장하지 않습니다.</p>

      <h2 style={H}>6. 책임의 제한</h2>
      <p>관련 법령이 허용하는 최대 범위 내에서, 서비스 이용 또는 이용 불능, 생성된 코드·명령의 실행으로 발생한 직접·간접·부수적·특별·결과적 손해에 대해 책임지지 않습니다.</p>

      <h2 style={H}>7. 약관의 변경</h2>
      <p>약관은 변경될 수 있으며, 변경 시 본 페이지에 게시합니다. 변경 후 계속 이용하면 변경에 동의한 것으로 봅니다.</p>

      <h2 style={H}>8. 문의</h2>
      <p>문의: psychiatristlee@gmail.com</p>
      <p style={{ color: "#b6a892", fontSize: 13, marginTop: 30 }}>
        본 문서는 일반적인 약관 템플릿이며 법률 자문이 아닙니다. 실제 서비스 운영 시 관할 법률에 맞춰 변호사의 검토를 받으시기 바랍니다.
      </p>
    </main>
  );
}
