export type Account={id:string;username:string;csrf:string;hub_address:string;is_admin?:boolean};
let csrf='';
export function useAccount(value:Account|null){csrf=value?.csrf??''}
export async function api<T=any>(path:string,body?:unknown,method?:string):Promise<T>{
 const response=await fetch(`/api/v1${path}`,{method:method??(body===undefined?'GET':'POST'),credentials:'same-origin',headers:{'X-Hub-Origin':location.origin,...(body===undefined&&method===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})},body:body===undefined?undefined:JSON.stringify(body)});
 const data=await response.json().catch(()=>({error:`HTTP ${response.status}`}));
 if(!response.ok)throw new Error(data.error??`HTTP ${response.status}`);
 return data as T;
}
