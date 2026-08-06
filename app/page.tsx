import { UnseenExperience } from "./components/unseen-experience";
import {
  chatGPTSignInPath,
  chatGPTSignOutPath,
  isChatGPTUserAllowed,
  requireChatGPTUser,
} from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  if (!isChatGPTUserAllowed(user)) {
    return (
      <main className="access-denied-shell">
        <div className="access-denied-card">
          <span>UNSEEN · PRIVATE TEST</span>
          <h1>Access not approved.</h1>
          <p>
            <strong>{user.email}</strong> is signed in, but this account is not on
            the UNSEEN tester allowlist.
          </p>
          <a href={chatGPTSignOutPath("/")}>Sign out and use another account</a>
        </div>
      </main>
    );
  }
  return (
    <UnseenExperience
      viewer={{ displayName: user.displayName, email: user.email }}
      signInPath={chatGPTSignInPath("/")}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
