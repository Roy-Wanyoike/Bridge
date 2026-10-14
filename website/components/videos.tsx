const VIDEOS = [
  {
    src: '/videos/bridge-intro.mp4',
    poster: '/images/bridge-video-intro-poster.png',
    title: 'Introducing Bridge',
    body: 'The 90-second tour: one contract compiling to every language, with validators in every runtime.',
    wide: true,
  },
  {
    src: '/videos/bridge-gate-demo.mp4',
    poster: '/images/bridge-og-image.png',
    title: 'The gate in action',
    body: 'A "harmless" field rename meets bridge diff — and never reaches main.',
  },
  {
    src: '/videos/bridge-social-square.mp4',
    poster: '/images/bridge-video-social-poster.png',
    title: 'Six languages, one truth',
    body: 'The square cut for social: the same contract, six runtimes, zero drift.',
  },
];

export function Videos() {
  return (
    <section id="videos" aria-labelledby="videos-heading" className="border-t border-border">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <h2 id="videos-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Watch it work
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          Short, real captures of the compiler, the compatibility gate, and the registry — no
          mockups.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-3">
          {VIDEOS.map((v) => (
            <figure
              key={v.src}
              className={`overflow-hidden rounded-xl border border-border bg-card ${
                v.wide ? 'lg:col-span-3' : ''
              }`}
            >
              <video
                controls
                preload="none"
                poster={v.poster}
                className={`w-full bg-black ${v.wide ? 'max-h-[540px] object-contain' : ''}`}
              >
                <source src={v.src} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
              <figcaption className="p-5">
                <h3 className="font-semibold text-foreground">{v.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{v.body}</p>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
