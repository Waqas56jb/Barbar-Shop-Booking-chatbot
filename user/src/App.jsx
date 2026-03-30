import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BOOKING_TRIGGER, SHOP } from './shop';
import {
  clientDeviceHint,
  escapeHtml,
  getApiBase,
  guessPrefillFromChat,
  normalizeBookingIntent,
  nowTime,
  stripBookingTrigger,
  todayISODate,
} from './utils';

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function UserBubbleContent({ text }) {
  const lines = escapeHtml(text ?? '').split('\n');
  return lines.map((line, i) => (
    <span key={i}>
      {i > 0 ? <br /> : null}
      {line}
    </span>
  ));
}

function BookingFormCard({ sessionIdRef, userTexts, onSuccess }) {
  const pre = guessPrefillFromChat(userTexts);
  const [name, setName] = useState(pre.name);
  const [phone, setPhone] = useState(pre.phone);
  const [service, setService] = useState('');
  const [preferredDate, setPreferredDate] = useState('');
  const [preferredTime, setPreferredTime] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const API_BASE = getApiBase();
  const BACKEND_BOOK = `${API_BASE}/api/book`;

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    const n = name.trim();
    const p = phone.trim();
    const s = service.trim();
    const d = preferredDate.trim();
    const t = preferredTime.trim();
    const note = notes.trim();
    if (!n || !p || !s || !d || !t) {
      setError('Please fill in all required fields.');
      return;
    }
    if (note.length > 200) {
      setError('Notes must be 200 characters or less.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(BACKEND_BOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          name: n,
          phone: p,
          service: s,
          preferredDate: d,
          preferredTime: t,
          notes: note,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Please try again.');
        setSubmitting(false);
        return;
      }
      onSuccess({ name: n, service: s, preferredDate: d, preferredTime: t });
    } catch {
      setError('Network error. Check your connection and try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="info-card booking-card">
      <div className="ic-title">📅 Confirm your appointment</div>
      <form className="booking-form-inner" noValidate onSubmit={onSubmit}>
        <div className="bf-field">
          <label htmlFor="bf-name">Name</label>
          <input
            id="bf-name"
            name="name"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
          />
        </div>
        <div className="bf-field">
          <label htmlFor="bf-phone">Phone</label>
          <input
            id="bf-phone"
            name="phone"
            required
            maxLength={40}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            autoComplete="tel"
          />
        </div>
        <div className="bf-field">
          <label htmlFor="bf-service">Service</label>
          <select
            id="bf-service"
            name="service"
            required
            value={service}
            onChange={(e) => setService(e.target.value)}
          >
            <option value="" disabled>
              Select a service…
            </option>
            {SHOP.services.map((sv) => (
              <option key={sv.name} value={sv.name}>
                {sv.name} — €{sv.price}
              </option>
            ))}
          </select>
        </div>
        <div className="bf-field">
          <label htmlFor="bf-date">Preferred date</label>
          <input
            type="date"
            id="bf-date"
            name="preferredDate"
            required
            min={todayISODate()}
            value={preferredDate}
            onChange={(e) => setPreferredDate(e.target.value)}
          />
        </div>
        <div className="bf-field">
          <label htmlFor="bf-time">Preferred time</label>
          <select
            id="bf-time"
            name="preferredTime"
            required
            value={preferredTime}
            onChange={(e) => setPreferredTime(e.target.value)}
          >
            <option value="" disabled>
              Select a time…
            </option>
            <option value="Morning (10:00–13:30)">Morning (10:00–13:30)</option>
            <option value="Afternoon (15:30–20:00)">Afternoon (15:30–20:00)</option>
            <option value="Saturday morning (10:00–15:00)">Saturday morning (10:00–15:00)</option>
          </select>
        </div>
        <div className="bf-field">
          <label htmlFor="bf-notes">
            Notes{' '}
            <span
              style={{
                fontWeight: 400,
                textTransform: 'none',
                letterSpacing: 0,
                color: 'var(--text-dim)',
              }}
            >
              (optional)
            </span>
          </label>
          <textarea
            id="bf-notes"
            name="notes"
            maxLength={200}
            placeholder="Any special requests?"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className={`booking-error${error ? ' visible' : ''}`} role="alert">
          {error}
        </div>
        <button type="submit" className="btn-confirm-booking" disabled={submitting}>
          Confirm Appointment ✅
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const API_BASE = useMemo(() => getApiBase(), []);
  const BACKEND_CHAT = `${API_BASE}/api/chat`;

  const sessionIdRef = useRef(null);
  const messagesRef = useRef(null);
  const inputRef = useRef(null);

  const [blocks, setBlocks] = useState(() => [{ type: 'dateDivider', id: 'today', label: 'Today' }]);
  const [inputValue, setInputValue] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [sendDisabled, setSendDisabled] = useState(false);

  useEffect(() => {
    if (API_BASE) console.info('[Chat] API:', API_BASE);
  }, [API_BASE]);

  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [blocks, isTyping]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/session/new`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceHint: clientDeviceHint() }),
        });
        const data = await res.json();
        if (!cancelled) sessionIdRef.current = data.sessionId;
      } catch {
        if (!cancelled) {
          sessionIdRef.current = crypto.randomUUID?.() || Math.random().toString(36).slice(2);
        }
      }
    })();
    const t = window.setTimeout(() => {
      setBlocks((prev) => [
        ...prev,
        {
          type: 'message',
          id: uid(),
          role: 'bot',
          html: `Hey there! 👋 Welcome to <strong>Barbería Cullera</strong>. I'm here at reception — I can sort out an appointment, walk you through prices, or answer anything about the shop. What can I help you with today? ✂️`,
          showLeadBadge: false,
          time: nowTime(),
        },
        {
          type: 'quickReplies',
          id: uid(),
          options: [
            { label: 'Book an appointment 📅', message: "I'd like to book an appointment" },
            'See services & prices 💈',
            'Opening hours 🕐',
            'Find us 📍',
          ],
        },
      ]);
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [API_BASE]);

  const userTexts = useMemo(
    () =>
      blocks
        .filter((b) => b.type === 'message' && b.role === 'user')
        .map((b) => b.text.trim())
        .filter(Boolean),
    [blocks],
  );

  const resizeTextarea = useCallback(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [inputValue, resizeTextarea]);

  const appendMessage = useCallback((role, payload, showLeadBadge = false) => {
    const time = nowTime();
    setBlocks((prev) => [
      ...prev,
      role === 'user'
        ? { type: 'message', id: uid(), role: 'user', text: payload, time }
        : { type: 'message', id: uid(), role: 'bot', html: payload, showLeadBadge, time },
    ]);
  }, []);

  const removeQuickReply = useCallback((id) => {
    setBlocks((prev) => prev.filter((b) => !(b.type === 'quickReplies' && b.id === id)));
  }, []);

  const removeServiceList = useCallback((id) => {
    setBlocks((prev) => prev.filter((b) => !(b.type === 'services' && b.id === id)));
  }, []);

  const handleLocalShortcut = useCallback(
    (text) => {
      const t = text.toLowerCase();

      if (/\b(services?|price|menu|list|how much|cost)\b/.test(t)) {
        appendMessage(
          'bot',
          "Here's our full service menu — tap any one to book it directly:",
        );
        setBlocks((prev) => [...prev, { type: 'services', id: uid(), items: SHOP.services }]);
        return true;
      }

      if (/\b(hour|open|clos|when|time|schedule|avail)\b/.test(t)) {
        appendMessage('bot', 'Here are our opening hours for the week:');
        const rows = SHOP.hours
          .map(
            (h) =>
              `<div class="ic-row">
        <span class="ic-label">${h.day}</span><br>
        <span class="${h.open ? '' : 'ic-closed'}">${h.time}</span>
      </div>`,
          )
          .join('');
        setBlocks((prev) => [
          ...prev,
          { type: 'infoCard', id: uid(), title: '🕐 Opening Hours', bodyHtml: rows },
          {
            type: 'quickReplies',
            id: uid(),
            options: [
              { label: 'Book a slot 📅', message: "I'd like to book an appointment" },
              'View services 💈',
              'Call us ☎️',
            ],
          },
        ]);
        return true;
      }

      if (/\b(where|location|address|map|direct|find you|how to get)\b/.test(t)) {
        appendMessage('bot', 'You can find us right here in Cullera:');
        setBlocks((prev) => [
          ...prev,
          {
            type: 'infoCard',
            id: uid(),
            title: '📍 Our Address',
            bodyHtml: `<div class="ic-row">${SHOP.address}</div>
       <br>
       <div class="ic-row"><a href="${SHOP.mapLink}" target="_blank" rel="noopener">Open in Google Maps →</a></div>`,
          },
          {
            type: 'quickReplies',
            id: uid(),
            options: [
              { label: 'Book appointment 📅', message: "I'd like to book an appointment" },
              'Our hours 🕐',
              'Call us ☎️',
            ],
          },
        ]);
        return true;
      }

      if (/\b(call|phone|ring|number|contact)\b/.test(t)) {
        appendMessage('bot', `You can reach us directly at <strong>${SHOP.phoneFmt}</strong> 📞`);
        setBlocks((prev) => [
          ...prev,
          {
            type: 'quickReplies',
            id: uid(),
            options: [
              'Call now ☎️',
              { label: 'Book appointment 📅', message: "I'd like to book an appointment" },
              'Our hours 🕐',
            ],
          },
        ]);
        return true;
      }

      if (/call now/.test(t)) {
        window.location.href = `tel:${SHOP.phone}`;
        appendMessage('bot', 'Dialling now… ☎️ Speak soon!');
        return true;
      }

      if (/\bwhatsapp\b/.test(t)) {
        appendMessage(
          'bot',
          'You can book everything right here in this chat — no WhatsApp needed. Want to start with a service? ✂️',
        );
        setBlocks((prev) => [
          ...prev,
          {
            type: 'quickReplies',
            id: uid(),
            options: [
              { label: 'Book an appointment 📅', message: "I'd like to book an appointment" },
              'See services 💈',
            ],
          },
        ]);
        return true;
      }

      return false;
    },
    [appendMessage],
  );

  const appendBookingForm = useCallback(() => {
    setBlocks((prev) => [
      ...prev.filter((b) => b.type !== 'booking'),
      { type: 'booking', id: uid(), time: nowTime() },
    ]);
  }, []);

  const onBookingSuccess = useCallback((payload) => {
    setBlocks((prev) => [
      ...prev.filter((b) => b.type !== 'booking'),
      {
        type: 'successCard',
        id: uid(),
        time: nowTime(),
        ...payload,
      },
    ]);
  }, []);

  const sendMessage = useCallback(
    async (text) => {
      const raw = (text || '').trim();
      if (!raw || isTyping) return;

      const outbound = normalizeBookingIntent(raw);

      appendMessage('user', outbound);
      setInputValue('');
      const ta = inputRef.current;
      if (ta) ta.style.height = 'auto';

      if (handleLocalShortcut(outbound)) {
        inputRef.current?.focus();
        return;
      }

      setIsTyping(true);
      setSendDisabled(true);

      try {
        const res = await fetch(BACKEND_CHAT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionIdRef.current,
            message: outbound,
            deviceHint: clientDeviceHint(),
          }),
        });

        setIsTyping(false);

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          appendMessage(
            'bot',
            err.error ||
              `Something went wrong (${res.status}). Try again or call us at ${SHOP.phoneFmt} 📞`,
          );
          return;
        }

        const data = await res.json();
        if (data.sessionId) sessionIdRef.current = data.sessionId;

        const rawReply = data.reply || '';
        const showForm = rawReply.includes(BOOKING_TRIGGER);
        const displayReply = stripBookingTrigger(rawReply);

        appendMessage('bot', displayReply, false);
        if (showForm) appendBookingForm();
      } catch (e) {
        console.error('Network error:', e);
        setIsTyping(false);
        appendMessage(
          'bot',
          `I'm having trouble connecting right now. Please call us directly at <strong>${SHOP.phoneFmt}</strong> and we'll sort you out! 📞`,
        );
        setBlocks((prev) => [
          ...prev,
          { type: 'quickReplies', id: uid(), options: ['Call now ☎️', 'Try again 🔄'] },
        ]);
      } finally {
        setIsTyping(false);
        setSendDisabled(false);
        inputRef.current?.focus();
      }
    },
    [appendBookingForm, appendMessage, BACKEND_CHAT, handleLocalShortcut, isTyping],
  );

  const onQuickReply = (qrId, opt) => {
    const message = typeof opt === 'string' ? opt : (opt.message ?? opt.label);
    removeQuickReply(qrId);
    sendMessage(message);
  };

  const onServicePick = (listId, item) => {
    removeServiceList(listId);
    sendMessage(`I'd like to book: ${item.name} (€${item.price})`);
  };

  return (
    <div className="shell" id="shell">
      <div className="header">
        <div className="avatar">✂️</div>
        <div className="header-info">
          <div className="shop-name">Barbería Cullera</div>
          <div className="shop-sub">● Reception · Happy to help</div>
        </div>
        <div className="hdr-actions">
          <a className="icon-btn" href="tel:617545837" title="Call us" aria-label="Call us">
            📞
          </a>
          <button
            className="icon-btn"
            type="button"
            title="Location"
            aria-label="Location"
            onClick={() =>
              window.open('https://maps.google.com/?q=Carrer+Ateneu+Musical+63a+Cullera+Valencia')
            }
          >
            📍
          </button>
        </div>
      </div>

      <div className="messages" id="messages" ref={messagesRef}>
        {blocks.map((b) => {
          if (b.type === 'dateDivider') {
            return (
              <div className="date-divider" key={b.id} id="dateDivider">
                {b.label}
              </div>
            );
          }
          if (b.type === 'message') {
            const bubbleInner =
              b.role === 'bot' ? (
                <div
                  className="bubble"
                  dangerouslySetInnerHTML={{
                    __html: (b.html || '').replace(/\n/g, '<br>'),
                  }}
                />
              ) : (
                <div className="bubble">
                  <UserBubbleContent text={b.text} />
                </div>
              );
            const wrap = (
              <div className="bubble-wrap" key="wrap">
                {bubbleInner}
                {b.showLeadBadge ? <div className="lead-badge">✅ Booking saved</div> : null}
                <span className="bubble-time">{b.time}</span>
              </div>
            );
            const av = (
              <div className="msg-avatar-sm" key="av">
                {b.role === 'bot' ? '✂️' : '👤'}
              </div>
            );
            return (
              <div className={`msg-row ${b.role}`} key={b.id}>
                {b.role === 'bot' ? [av, wrap] : [wrap, av]}
              </div>
            );
          }
          if (b.type === 'quickReplies') {
            return (
              <div className="quick-replies" key={b.id}>
                {b.options.map((opt, i) => {
                  const label = typeof opt === 'string' ? opt : opt.label;
                  return (
                    <button
                      type="button"
                      key={i}
                      className="qr-btn"
                      onClick={() => onQuickReply(b.id, opt)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            );
          }
          if (b.type === 'services') {
            return (
              <div className="service-list" key={b.id}>
                {b.items.map((item) => (
                  <div
                    role="button"
                    tabIndex={0}
                    key={item.name}
                    className="svc-card"
                    onClick={() => onServicePick(b.id, item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onServicePick(b.id, item);
                      }
                    }}
                  >
                    <span className="svc-name">{item.name}</span>
                    <span className="svc-price">€{item.price}</span>
                  </div>
                ))}
              </div>
            );
          }
          if (b.type === 'infoCard') {
            return (
              <div
                key={b.id}
                className="info-card"
                dangerouslySetInnerHTML={{
                  __html: `<div class="ic-title">${b.title}</div>${b.bodyHtml}`,
                }}
              />
            );
          }
          if (b.type === 'booking') {
            return (
              <div className="msg-row bot" key={b.id} data-booking-form="1">
                <div className="msg-avatar-sm">✂️</div>
                <div className="bubble-wrap">
                  <BookingFormCard
                    sessionIdRef={sessionIdRef}
                    userTexts={userTexts}
                    onSuccess={onBookingSuccess}
                  />
                  <span className="bubble-time">{b.time}</span>
                </div>
              </div>
            );
          }
          if (b.type === 'successCard') {
            return (
              <div className="msg-row bot" key={b.id}>
                <div className="msg-avatar-sm">✂️</div>
                <div className="bubble-wrap">
                  <div className="info-card success-card">
                    <div className="success-icon" aria-hidden="true">
                      ✓
                    </div>
                    <h3>Appointment Requested!</h3>
                    <div className="success-summary">
                      <strong>{b.name}</strong>
                      <br />
                      {b.service}
                      <br />
                      {b.preferredDate || '—'} · {b.preferredTime || '—'}
                    </div>
                    <div className="success-note">
                      We&apos;ll confirm by phone at{' '}
                      <a href={`tel:${SHOP.phone}`}>{SHOP.phoneFmt}</a>.
                    </div>
                    <div className="lead-badge">✅ Booking saved</div>
                  </div>
                  <span className="bubble-time">{b.time}</span>
                </div>
              </div>
            );
          }
          return null;
        })}

        {isTyping ? (
          <div className="typing-row" id="typingIndicator">
            <div className="msg-avatar-sm">✂️</div>
            <div className="typing-bubble">
              <div className="dot" />
              <div className="dot" />
              <div className="dot" />
            </div>
          </div>
        ) : null}
      </div>

      <div className="input-area">
        <div className="input-wrap">
          <textarea
            ref={inputRef}
            className="user-input"
            rows={1}
            placeholder="Type a message…"
            autoComplete="off"
            autoCorrect="on"
            spellCheck
            value={inputValue}
            disabled={sendDisabled}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage(inputValue);
              }
            }}
          />
        </div>
        <button
          className="send-btn"
          type="button"
          aria-label="Send message"
          disabled={sendDisabled}
          onClick={() => sendMessage(inputValue)}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  );
}
