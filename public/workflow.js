(function (root) {
  const tools = {
    admin: {name:'i3D Admin',url:'https://admin.i3d.net/'},
    netbox: {name:'NetBox',url:'https://netbox.i3d.network/'},
    wiki: {name:'OPS Wiki',url:'https://i3dnet.atlassian.net/wiki/spaces/OPS/overview'},
    sites: {name:'Sites Information',url:'https://i3dnet.atlassian.net/wiki/spaces/OPS/pages/107544773/i3D.net+sites+information'},
    qa: {name:'QA',url:'https://qa.i3d.network/'}
  };
  const rules = [
    {pattern:/\b(?:network|connectivity|packet loss|latency|switch|router|routing|bgp|vlan|port|uplink|ping|traceroute|dns|dhcp)\b/gi,tools:['netbox','admin'],reason:'Network terms in the ticket'},
    {pattern:/\b(?:disk|ssd|hdd|raid|memory|ram|cpu|hardware|server|host|idrac|ilo|ipmi|bmc)\b/gi,tools:['admin','netbox'],reason:'Hardware or host terms in the ticket'},
    {pattern:/\b(?:rack|cage|suite|cabling|cable|datacentre|datacenter|site|installation|racking)\b/gi,tools:['netbox','sites'],reason:'Location or physical work in the ticket'},
    {pattern:/\b(?:power|reboot|restart|pdu|outage)\b/gi,tools:['admin','sites'],reason:'Power or restart terms in the ticket'},
    {pattern:/\b(?:qa|test|testing|validation|validate|benchmark)\b/gi,tools:['qa'],reason:'Testing or validation terms in the ticket'}
  ];
  function analyze(ticket) {
    const text = [ticket.title,ticket.description,ticket.sourceText,ticket.requestType,ticket.type,ticket.labels,ticket.components].filter(Boolean).join('\n');
    const keywords = new Set();
    const recommendations = new Map();
    function suggest(id,reason) { if (!recommendations.has(id)) recommendations.set(id,{...tools[id],reason}); }
    for (const rule of rules) {
      const matches = [...text.matchAll(rule.pattern)];
      if (!matches.length) continue;
      for (const match of matches) keywords.add(match[0].toLowerCase());
      for (const id of rule.tools) suggest(id,rule.reason);
    }
    const addresses = [...text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)].map(match=>match[0]).filter(ip=>ip.split('.').every(part=>Number(part)<=255));
    for (const ip of addresses) keywords.add(ip);
    for (const field of ['location','rack','unit','serviceTag']) if (ticket[field]) keywords.add(String(ticket[field]));
    if (addresses.length || ticket.serviceTag || ticket.rack) suggest('netbox','An address, asset, or rack is identified');
    if (ticket.location) suggest('sites','A site is identified in the ticket');
    if (!recommendations.size) suggest('admin','General ticket reference');
    suggest('wiki','Procedures and reference documentation');
    return {keywords:[...keywords].slice(0,18),tools:[...recommendations.values()]};
  }
  function draftKey(ticket) {
    if (ticket.key && ticket.key !== 'UNKEYED') return ticket.key;
    const text = JSON.stringify([ticket.title,ticket.description,ticket.sourceText]);
    let hash = 2166136261;
    for (let i=0;i<text.length;i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619);
    return 'pasted-' + (hash>>>0).toString(16);
  }
  function template(ticket,mode) {
    const key = ticket.key && ticket.key !== 'UNKEYED' ? ticket.key : 'your request';
    if (mode === 'customer') return greeting(ticket);
    const coordinates = [['Site',ticket.location],['Rack',ticket.rack],['Unit',ticket.unit],['Service tag',ticket.serviceTag]].filter(([,value])=>value).map(([label,value])=>`${label}: ${value}`);
    return [`Ticket: ${key}`,`Summary: ${ticket.title||''}`,...coordinates,'','Findings:','','Actions taken:','','Next steps:',''].join('\n');
  }
  function greeting(ticket,body='') {
    const reporter=String(ticket.reporter||'').trim();
    const salutation=reporter?'Hello '+reporter+',':'Hello,';
    let text=String(body).trim();
    text=text.replace(/^Hello(?: [^,\n]+)?,[ \t]*\n*/i,'').replace(/(?:^|\n+)Thank you[.!]?[ \t]*$/i,'').trim();
    return salutation+'\n\n'+text+'\n\nThank you.';
  }
  const api = {analyze,draftKey,template,greeting};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OpsWorkflow = api;
})(typeof window !== 'undefined' ? window : globalThis);
