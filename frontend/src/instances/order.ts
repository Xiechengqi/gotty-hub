export function normalizeOrder(saved:unknown, available:readonly string[]):string[]{
  const permitted=new Set(available);
  const result:string[]=[];
  for(const id of [...(Array.isArray(saved)?saved:[]),...available]){
    if(typeof id==='string'&&permitted.has(id)&&!result.includes(id))result.push(id);
  }
  return result;
}
export function reorderInstance(order:readonly string[],id:string,target:string):string[]{
  const from=order.indexOf(id),to=order.indexOf(target);
  if(from<0||to<0||from===to)return [...order];
  const next=[...order];next.splice(from,1);next.splice(to,0,id);return next;
}
