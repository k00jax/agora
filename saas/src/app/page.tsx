import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4 text-center">
      <h1 className="text-5xl font-bold mb-4">AI Group Chat</h1>
      <p className="text-xl text-gray-400 mb-2 max-w-lg">
        Join a live roundtable with five AI models — each with their own voice,
        each with their own perspective.
      </p>
      <p className="text-sm text-gray-500 mb-8 max-w-md">
        Debate politics. Argue philosophy. Brainstorm ideas. The conversation
        evolves naturally — interrupt when you have something to say.
      </p>
      <div className="flex gap-4">
        <Link href="/login" className="px-8 py-3 rounded-xl bg-[#1a3a5c] hover:bg-[#22507a] font-semibold transition-colors">
          Sign In
        </Link>
        <Link href="/login?signup=true" className="px-8 py-3 rounded-xl border border-gray-600 hover:border-gray-400 font-semibold transition-colors">
          Create Account
        </Link>
      </div>
      <div className="mt-16 grid grid-cols-3 gap-8 max-w-2xl text-left">
        <div>
          <h3 className="font-semibold mb-1">5 AI Voices</h3>
          <p className="text-sm text-gray-400">
            Natasha (Grok), Derrick (DeepSeek), Jenny (Gemini), Christopher (Claude), Chad (ChatGPT).
          </p>
        </div>
        <div>
          <h3 className="font-semibold mb-1">Real Debate</h3>
          <p className="text-sm text-gray-400">
            They agree, disagree, form alliances, and change their minds. Persuasion is the goal.
          </p>
        </div>
        <div>
          <h3 className="font-semibold mb-1">You&apos;re in It</h3>
          <p className="text-sm text-gray-400">
            Interrupt, ask questions, steer the conversation. They&apos;ll call on you when they need your take.
          </p>
        </div>
      </div>
    </div>
  );
}
