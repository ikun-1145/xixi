// Internal-only synthetic endpoints for preproduction Workerd integration.
// There are no outgoing fetch calls, URLs, payment transfers, or entitlements.
const UUID = '11111111-1111-4111-8111-111111111111';
const SAMPLE = Object.freeze({
  merchant:'MER_PREPROD1',store:'STO_PREPROD1',
  product:'PROD_PREPROD1',order:'ORD_PREPROD1',payment:'PAY_PREPROD1'
});
const json=(data,status=200)=>new Response(JSON.stringify(data),{
  status,headers:{'content-type':'application/json','cache-control':'no-store'}
});
export default {
  async fetch(request) {
    if(request.method!=='POST')return json({ok:false},405);
    const url=new URL(request.url);
    if(url.origin==='https://waffo-provider.preprod.invalid'&&url.pathname==='/v1/graphql'){
      let body;try{body=await request.json()}catch{return json({errors:[{message:'bad_test_body'}]},400)}
      if(body?.variables?.id!==SAMPLE.order||body?.variables?.merchant!==SAMPLE.merchant)
        return json({errors:[{message:'unknown_synthetic_order'}]},400);
      return json({data:{
        merchant:{id:SAMPLE.merchant,storeMerchants:[{store:{id:SAMPLE.store}}]},
        onetimeOrder:{id:SAMPLE.order,store:{id:SAMPLE.store},
          onetimeProduct:{id:SAMPLE.product},testMode:false,currency:'CNY',
          status:'completed',orderMerchantExternalId:UUID,
          payments:[{id:SAMPLE.payment,status:'succeeded',refunds:[]}]}
      }});
    }
    if(url.origin==='https://waffo-rpc.preprod.invalid'&&
      url.pathname==='/rest/v1/rpc/sunland_waffo_apply_event'){
      let payload;try{payload=await request.json()}catch{return json({},400)}
      if(payload?.p_event?.payment_reference!==UUID||payload?.p_event?.entitlement_enabled!==false)
        return json({error:'not_synthetic_test_event'},403);
      // No PostgreSQL and no Pro changes: an acknowledgment only.
      return json({status:'recorded',version:1,paymentConfirmed:true,entitlementState:'pending'});
    }
    return json({error:'preprod_mock_not_supported'},404);
  },
};
