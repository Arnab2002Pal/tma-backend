Meta's webhook has a timeout. If your endpoint doesn't return 200 within 5 seconds, Meta marks the delivery as failed and retries the same message.
Your current flow inside the handler:
Receive message
    → getMediaUrl (network call)
    → downloadMedia (network call) 
    → Whisper transcription (1–3 seconds)
    → Haiku emergency check (network call)
    → Q1 button send (network call)
    → return 200
That chain can easily take 5–8 seconds. Meta doesn't wait. It retries. Now you're processing the same message twice — which is exactly why dedup exists, but why create the problem in the first place.
setImmediate detaches the processing from the request lifecycle. Response goes back to Meta instantly, processing continues in the background.
Receive message → return 200 immediately
                        ↓ (background)
                  getMediaUrl → Whisper → Haiku → send Q1
Meta is happy. No retries. No duplicates.



problem is that keyword matching fundamentally cannot handle natural language variation
The concern with this approach was cost — running Haiku on every single message. Let's look at the real numbers:
Haiku with max_tokens: 20 costs roughly $0.00003 per call (input ~200 tokens + output ~5 tokens). At 500 messages per day that's Rs 1.25/day. Negligible.
The keyword gate was a cost optimisation that isn't worth the brittleness at TMA's scale. You're not running 100k messages/day.