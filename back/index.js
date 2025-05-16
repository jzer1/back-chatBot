const app = require('./app')

app.listen(app.get('port'),()=>{
    console.log("servidor funcionando", app.get("port"))
}
)