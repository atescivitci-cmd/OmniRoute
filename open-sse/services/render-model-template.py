import json,sys
from pathlib import Path
from jinja2.sandbox import ImmutableSandboxedEnvironment

try:
    data=json.load(sys.stdin)
    style=data.pop('_json_style','spaces')
    env=ImmutableSandboxedEnvironment(trim_blocks=True,lstrip_blocks=True,extensions=['jinja2.ext.loopcontrols'])
    def tojson(value):
        return json.dumps(value,ensure_ascii=False,sort_keys=style.endswith('sorted'),separators=(',',':') if style.startswith('compact') else (', ',': '))
    def fail(message):
        raise ValueError('Model template rejected request layout')
    env.filters['tojson']=tojson
    env.globals['raise_exception']=fail
    template=env.from_string((Path(__file__).parent/'model-chat-template.jinja').read_text())
    print(json.dumps({'prompt':template.render(**data,add_generation_prompt=True,enable_thinking=False,bos_token='',eos_token='<|im_end|>')},ensure_ascii=False))
except Exception as exc:
    print(json.dumps({'render_error_type':type(exc).__name__}))
    sys.exit(1)
