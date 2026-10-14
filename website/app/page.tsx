import { Nav } from '@/components/nav';
import { Hero } from '@/components/hero';
import { Demo } from '@/components/demo';
import { Problem } from '@/components/problem';
import { Moat } from '@/components/moat';
import { Languages } from '@/components/languages';
import { Videos } from '@/components/videos';
import { Resources } from '@/components/resources';
import { Footer } from '@/components/footer';

export default function Page() {
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <Nav />
      <main id="main">
        <Hero />
        <Demo />
        <Problem />
        <Moat />
        <Languages />
        <Videos />
        <Resources />
      </main>
      <Footer />
    </>
  );
}
