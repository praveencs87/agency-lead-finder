import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

// Build Google search query URLs for agency discovery
function buildSearchUrls(niche, location, page = 0) {
    const loc = location ? ` ${location}` : '';
    const queries = [
        `"${niche} agency"${loc} site:linkedin.com/company`,
        `top ${niche} digital marketing agency${loc}`,
        `best ${niche} web design agency${loc}`,
    ];
    // Use Google's start param for pagination (10 results per page)
    return queries.map(q =>
        `https://www.google.com/search?q=${encodeURIComponent(q)}&start=${page * 10}&num=10`
    );
}

function cleanUrl(url) {
    try {
        // Remove Google redirect wrappers
        const parsed = new URL(url);
        const q = parsed.searchParams.get('q') || parsed.searchParams.get('url');
        return q || url;
    } catch {
        return url;
    }
}

await Actor.init();

try {
    const input = await Actor.getInput();
    const { niches = [], location = '', maxLeadsPerNiche = 30 } = input;

    if (!niches || niches.length === 0) {
        throw new Error('At least one niche is required!');
    }

    log.info(`Starting Agency Lead Finder for niches: ${niches.join(', ')}`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    // Use Apify proxy to access Google
    const proxyConfig = await Actor.createProxyConfiguration({ useApifyProxy: true });

    const nicheLeadCount = {};
    let totalExtracted = 0;
    const seenDomains = new Set(); // Deduplication

    const crawler = new CheerioCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        async requestHandler({ request, $, log }) {
            const { niche } = request.userData;
            nicheLeadCount[niche] = nicheLeadCount[niche] || 0;

            // Parse Google SERP results
            const results = $('div.g, div[data-hveid]');

            results.each((i, el) => {
                if (nicheLeadCount[niche] >= maxLeadsPerNiche) return false;

                const titleEl = $(el).find('h3').first();
                const name = titleEl.text().trim();
                if (!name) return;

                const linkEl = $(el).find('a[href^="http"]').first();
                let website = linkEl.attr('href') || '';
                website = cleanUrl(website);

                // Skip Google-internal URLs
                if (!website || website.includes('google.com')) return;

                // Extract domain for deduplication
                let domain = '';
                try { domain = new URL(website).hostname; } catch { return; }
                if (seenDomains.has(domain)) return;
                seenDomains.add(domain);

                const snippet = $(el).find('div[data-sncf], div[class*="snippet"], span[class*="st"]').first().text().trim()
                    || $(el).find('div').last().text().trim().substring(0, 200);

                const record = {
                    name: name.replace(/\s*-\s*.*$/, '').trim(), // Strip taglines from title
                    website,
                    description: snippet,
                    niche,
                    location: location || 'Global',
                    source_query: request.url,
                    scrapedAt: new Date().toISOString()
                };

                Actor.pushData(record).catch(() => {});
                Actor.charge({ eventName: 'lead-extracted', count: 1 }).catch(() => {});
                nicheLeadCount[niche]++;
                totalExtracted++;
                log.info(`🏢 [${niche}] ${name} → ${domain} (${nicheLeadCount[niche]}/${maxLeadsPerNiche})`);
            });
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed: ${request.url}`);
        },
    });

    // Build requests for all niches
    const initialRequests = [];
    for (const niche of niches) {
        const urls = buildSearchUrls(niche, location, 0);
        for (const url of urls) {
            initialRequests.push({ url, userData: { niche } });
        }
    }

    await crawler.addRequests(initialRequests);
    await crawler.run();

    log.info(`🎉 Done! Extracted ${totalExtracted} agency leads across ${niches.length} niches.`);
} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
