import { useEffect, useState } from 'react';
import { api, type AnswerRecord } from '../api';

export function AnswerHistory({ taskId, count }: { taskId: string; count: number }) {
  const [items, setItems] = useState<AnswerRecord[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ id: string; at: 'question' | 'answer'; text: string; available: boolean } | null>(null);
  useEffect(() => { let live = true; api.answers(taskId).then(a => { if (live) setItems(a); }).catch(() => {}); return () => { live = false; }; }, [taskId, count]);
  const jump = async (id: string, at: 'question' | 'answer') => {
    setOpen(id);
    try { setTranscript({ id, at, ...await api.answerTranscript(taskId, id, at) }); }
    catch { setTranscript({ id, at, text: '', available: false }); }
  };
  return <section className="answer-history" aria-label="Answer history">
    <h3>Answers to your questions</h3>
    {!items.length && <p>No answers have been captured yet.</p>}
    {items.slice().reverse().map(a => <article key={a.id} className="answer-history-item">
      <button className="answer-history-open" onClick={() => { setOpen(open === a.id ? null : a.id); setTranscript(null); }} aria-expanded={open === a.id}>
        <span>{a.question}</span><strong>{a.answer}</strong><small>{new Date(a.answeredAt).toLocaleString()}</small>
      </button>
      {open === a.id && <div className="answer-history-detail">
        <p><b>Question:</b> {a.question}</p><p><b>Short answer:</b> {a.answer}</p>
        <div className="answer-history-actions">
          <button onClick={() => void jump(a.id, 'question')}>Jump to question</button>
          <button onClick={() => void jump(a.id, 'answer')}>Jump to answer</button>
        </div>
        {transcript?.id === a.id && <div className="answer-history-transcript" role="region" aria-label={`${transcript.at} in transcript`}>
          <b>{transcript.at === 'question' ? 'Question' : 'Agent reply'} in transcript</b>
          {transcript.available ? <pre>{transcript.text}</pre> : <p>The transcript file is unavailable. The saved question and short answer remain above.</p>}
        </div>}
      </div>}
    </article>)}
  </section>;
}
